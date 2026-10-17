import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeOmitted, describeCompressed, OMITTED_NOTE_MAX_CHARS } from "./truncate.js";
import { renderBashOutput } from "./bash.js";
import { useFakeHome } from "../test-support/fake-home.js";

describe("describeOmitted", () => {
  it("is empty when nothing notable was cut (note stays byte-identical)", () => {
    const omitted = Array.from({ length: 500 }, (_, i) => `item ${i}: ok`);
    expect(describeOmitted(omitted, "")).toBe("");
  });

  it("counts errors/warnings, names labels + files, quotes first distinct errors", () => {
    const omitted = [
      "INFO boot",
      "2026-01-01T00:00:00Z ERROR db: connection reset (ECONNRESET)",
      "2026-01-01T00:00:01Z ERROR db: connection reset (ECONNRESET)",
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at handler (/srv/api/routes/users.ts:88:14)",
      "WARN slow query 2300ms",
    ];
    const d = describeOmitted(omitted, "");
    expect(d).toBe(
      'Omitted part: 3 error lines, 1 warning line (ECONNRESET, TypeError); 1 file: …/routes/users.ts; first: "2026-01-01T00:00:00Z ERROR db: connection reset (ECONNRESET)" | "TypeError: Cannot read properties of undefined (reading \'id\')".',
    );
  });

  it("covers rustc / tsc / python shapes (headroom #3635 labels + files)", () => {
    const d = describeOmitted(
      [
        "error[E0425]: cannot find value `cfg` in this scope",
        "  --> src/main.rs:12:5",
        "src/a.ts(3,4): error TS2345: Argument of type 'x' is not assignable",
        '  File "/srv/app/config.py", line 42, in load',
        "KeyError: 'port'",
      ],
      "",
    );
    expect(d).toContain("3 error lines (E0425, TS2345, KeyError)");
    expect(d).toContain("3 files: src/main.rs, src/a.ts, …/app/config.py");
  });

  it("leaves out labels/files/lines already visible in the shown part", () => {
    const shown = "KeyError: 'port'\n  File \"/srv/app/config.py\", line 42";
    const d = describeOmitted(['  File "/srv/app/config.py", line 42', "KeyError: 'port'"], shown);
    expect(d).toBe("Omitted part: 1 error line.");
  });

  it("does not treat source code as errors", () => {
    const code = [
      "    error: errMsg.slice(0, 200),",
      '  throw new Error("path escapes root");',
      "  console.error(err);",
      "const ERROR = 1;",
      "  if (warning) return;",
      "// handle the error: retry",
    ];
    expect(describeOmitted(code, "")).toBe("");
  });

  it("is hard-capped and deterministic", () => {
    const omitted: string[] = [];
    for (let i = 0; i < 200; i++) {
      omitted.push(`ERROR ${"x".repeat(200)} variant-${String.fromCharCode(97 + (i % 26))}`);
      omitted.push(`    at fn${i} (/very/long/path/to/some/module_${i}.ts:${i}:1)`);
      omitted.push(`Custom${i}Error: boom`);
    }
    const a = describeOmitted(omitted, "");
    expect(a.length).toBeLessThanOrEqual(OMITTED_NOTE_MAX_CHARS);
    expect(a).toContain("400 error lines");
    expect(describeOmitted(omitted, "")).toBe(a);
  });
});

describe("describeCompressed + bash note", () => {
  let tmpDir: string;
  let restoreHome: () => void;

  // Over-limit output is offloaded to ~/.gg/tool-output; keep it out of the real home.
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "truncate-omitted-test-"));
    restoreHome = useFakeHome(path.join(tmpDir, "home"));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("describes only lines the compressor dropped", () => {
    const original = ["a", "ERROR boom", "b"].join("\n");
    expect(describeCompressed(original, original)).toBe("");
    expect(describeCompressed(original, "a\nb")).toBe(
      'Omitted part: 1 error line; first: "ERROR boom".',
    );
  });

  it("bash truncation note names files from dropped stack frames", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`tests/test_${i}.py::test_${i} PASSED`);
    lines.push("Traceback (most recent call last):");
    for (let d = 0; d < 12; d++)
      lines.push(`  File "/srv/lib/layer${d}.py", line ${d + 1}, in f${d}`);
    lines.push("KeyError: 'port'");
    for (let i = 0; i < 40; i++) lines.push(`tail ${i}`);
    const out = await renderBashOutput(lines.join("\n"));
    const note = out.split("\n")[0];
    expect(note).toMatch(/^\[Compressed \(log\).*Omitted part: \d+ files: /);
    // Regression: the offloaded full output must land in the fake home, not the real one.
    const saved = /Full output saved to (.+?) — /.exec(note ?? "")?.[1];
    expect(saved).toBeDefined();
    expect(path.resolve(saved ?? "")).toContain(path.resolve(tmpDir, "home"));
  });
});
