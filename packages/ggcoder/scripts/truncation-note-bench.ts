/**
 * Offline byte-budget bench for truncation notes (#7: "say WHAT was cut").
 *
 * Feeds realistic oversized outputs through the REAL tool render paths —
 * `renderBashOutput` (bash; task_output uses the same compress+note shape),
 * the `read` tool (head truncation) — and reports the UTF-8 bytes of the
 * tool-result text the model receives, plus the note line itself. The random
 * overflow path is normalised to a fixed placeholder so runs are comparable.
 *
 *   HOME=$(mktemp -d) pnpm --filter @kenkaiiii/ggcoder exec tsx scripts/truncation-note-bench.ts [--json out.json]
 *
 * No network, no API key. Deterministic (seeded PRNG).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBashOutput } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";

const rand = (() => {
  let s = 42;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
})();
const ri = (n: number) => Math.floor(rand() * n);

interface Fixture {
  name: string;
  tool: "bash" | "read";
  build: () => string | Promise<string>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

const fixtures: Fixture[] = [
  {
    name: "build log, FATAL mid (bash)",
    tool: "bash",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const t = `2026-06-22T10:${String(i % 60).padStart(2, "0")}:00Z`;
        if (i === 2600)
          l.push(`${t} ERROR module=renderer FATAL: heap allocation failed at chunk 8821`);
        else l.push(`${t} INFO  compiled module ${i} ok (${ri(200)}ms)`);
      }
      return l.join("\n");
    },
  },
  {
    name: "test runner 1 fail/2000 (bash)",
    tool: "bash",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 2000; i++) {
        if (i === 1450) {
          l.push(`✗ user-auth › rejects expired token`);
          l.push(`  AssertionError: Expected 401 but received 200`);
          l.push(`    at Object.<anonymous> (auth.test.ts:88:14)`);
        } else l.push(`✓ suite-${i % 50} › case ${i} (${ri(12)}ms)`);
      }
      return l.join("\n");
    },
  },
  {
    name: "pytest deep tracebacks (bash)",
    tool: "bash",
    build: () => {
      const l: string[] = ["============ test session starts ============"];
      for (let i = 0; i < 1500; i++) l.push(`tests/test_mod${i % 40}.py::test_case_${i} PASSED`);
      for (const [exc, f] of [
        ["KeyError: 'port'", "app/config.py"],
        ["ValueError: invalid literal for int() with base 10: 'x'", "app/parse.py"],
      ]) {
        l.push("Traceback (most recent call last):");
        for (let d = 0; d < 18; d++) {
          l.push(`  File "/srv/app/lib/layer${d}.py", line ${10 + d}, in call_${d}`);
          l.push(`    return next_layer(ctx, ${d})`);
        }
        l.push(`  File "/srv/${f}", line 42, in load`);
        l.push(`    value = cfg["port"]`);
        l.push(exc);
        for (let i = 0; i < 30; i++) l.push(`tests/test_tail${i}.py::test_${i} PASSED`);
      }
      l.push("======= 2 failed, 1530 passed in 12.3s =======");
      return l.join("\n");
    },
  },
  {
    name: "cargo build warnings (bash)",
    tool: "bash",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 2000; i++) l.push(`   Compiling crate-${i} v0.${i % 9}.0`);
      for (let i = 0; i < 60; i++) {
        l.push(`warning: unused variable: \`x${i}\``);
        l.push(`  --> src/module_${i % 12}.rs:${10 + i}:9`);
        l.push(`   |`);
        l.push(`${10 + i} |     let x${i} = compute();`);
        l.push(`   |         ^^ help: prefix with underscore`);
        l.push("");
      }
      l.push("error[E0425]: cannot find value `cfg` in this scope");
      l.push("  --> src/main.rs:12:5");
      l.push("error: could not compile `app` due to 1 previous error; 60 warnings emitted");
      return l.join("\n");
    },
  },
  {
    name: "repeated retry spam (bash)",
    tool: "bash",
    build: () => {
      const l = ["starting worker pool"];
      for (let i = 0; i < 4000; i++) l.push("WARN retry: Connection refused: postgres:5432");
      l.push("ERROR giving up after 4000 attempts");
      return l.join("\n");
    },
  },
  {
    name: "npm ls plain (bash, nothing notable)",
    tool: "bash",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 4000; i++) l.push(`├── pkg-${i}@${ri(9)}.${ri(20)}.${ri(30)}`);
      return l.join("\n");
    },
  },
  {
    name: "server log errors after L2000 (read)",
    tool: "read",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 3500; i++) {
        if (i === 2400)
          l.push(`[2026-06-22 10:00:01] ERROR db: connection reset by peer (ECONNRESET)`);
        else if (i === 2410)
          l.push(`TypeError: Cannot read properties of undefined (reading 'id')`);
        else if (i === 2411) l.push(`    at handler (/srv/api/routes/users.ts:88:14)`);
        else if (i === 3100) l.push(`[2026-06-22 10:05:00] WARN slow query 2300ms`);
        else l.push(`[2026-06-22 10:00:00] INFO GET /api/items/${i} 200 ${ri(40)}ms`);
      }
      return l.join("\n");
    },
  },
  {
    name: "big source file: agent-loop.ts (read)",
    tool: "read",
    build: () => fs.readFile(path.join(here, "../../gg-agent/src/agent-loop.ts"), "utf-8"),
  },
  {
    name: "generated list (read, nothing notable)",
    tool: "read",
    build: () => {
      const l: string[] = [];
      for (let i = 0; i < 5000; i++) l.push(`item ${i}: ${"lorem ipsum ".repeat(ri(4) + 1)}`);
      return l.join("\n");
    },
  },
];

function noteOf(out: string, tool: Fixture["tool"]): string {
  const lines = out.split("\n");
  return tool === "bash" ? lines[0] : lines[lines.length - 1];
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "trunc-note-bench-"));
const read = createReadTool(tmp);
const rows: { name: string; bytes: number; noteBytes: number; note: string }[] = [];
for (const f of fixtures) {
  const raw = await f.build();
  let out: string;
  if (f.tool === "bash") out = await renderBashOutput(raw);
  else {
    const p = path.join(tmp, "f.txt");
    await fs.writeFile(p, raw);
    const r = await read.execute({ file_path: p }, {
      signal: new AbortController().signal,
      toolCallId: "b",
    } as never);
    out = typeof r === "string" ? r : JSON.stringify(r);
  }
  out = out.replace(/\/[^\s]*tool-output\/[^\s]*?\.txt/g, "<overflow>");
  const note = noteOf(out, f.tool);
  rows.push({
    name: f.name,
    bytes: Buffer.byteLength(out, "utf-8"),
    noteBytes: Buffer.byteLength(note, "utf-8"),
    note,
  });
}
await fs.rm(tmp, { recursive: true, force: true });

console.log("\nTruncation-note bench — tool-result bytes (overflow path normalised)\n");
for (const r of rows) {
  console.log(
    `${r.name.padEnd(42)} total ${String(r.bytes).padStart(7)} B   note ${String(r.noteBytes).padStart(4)} B`,
  );
  console.log(`    ${r.note}`);
}
const total = rows.reduce((n, r) => n + r.bytes, 0);
const notes = rows.reduce((n, r) => n + r.noteBytes, 0);
console.log(`\nTOTAL ${total} B   notes ${notes} B`);

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx > 0 && process.argv[jsonIdx + 1]) {
  await fs.writeFile(process.argv[jsonIdx + 1], JSON.stringify({ rows, total, notes }, null, 2));
}
