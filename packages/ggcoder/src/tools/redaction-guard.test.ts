import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REDACTION_MARKER } from "@kenkaiiii/gg-ai";
import { createEditTool } from "./edit.js";
import { createWriteTool } from "./write.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";
import { hasHiddenValues, redactionLossError } from "./redaction-guard.js";

// Built from parts so the fixture reads the same in any redacted transcript.
const SECRET = ["abcd1234", "efgh5678"].join("");
const ENV_FILE = `OPENAI_API_KEY=${SECRET}\nDEBUG=true\n`;
const MODEL_VIEW = `OPENAI_API_KEY=${REDACTION_MARKER}\nDEBUG=true\n`;
const ctx = { signal: new AbortController().signal, toolCallId: "t" };

describe("redactionLossError", () => {
  it("flags a rewrite that swaps a hidden value for the placeholder", () => {
    expect(hasHiddenValues(ENV_FILE)).toBe(true);
    expect(redactionLossError(ENV_FILE, MODEL_VIEW, ".env")).toContain("Nothing was written");
  });

  it("allows files the model saw in full, even when they contain the marker text", () => {
    const testFile = `expect(out).toBe("${REDACTION_MARKER}");\n`;
    expect(hasHiddenValues(testFile)).toBe(false);
    expect(redactionLossError(testFile, testFile + testFile, "a.test.ts")).toBeNull();
  });

  it("allows new files and writes that add no markers", () => {
    expect(redactionLossError(undefined, MODEL_VIEW, ".env")).toBeNull();
    expect(redactionLossError(ENV_FILE, ENV_FILE.replace("true", "false"), ".env")).toBeNull();
  });
});

describe("write/edit tools keep hidden secrets intact", () => {
  let tmpDir: string;
  let envPath: string;
  let tracker: ReadTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "redaction-guard-"));
    envPath = path.join(tmpDir, ".env");
    await fs.writeFile(envPath, ENV_FILE);
    tracker = new Map();
    const stat = await fs.stat(envPath);
    recordRead(tracker, envPath, ENV_FILE, stat.mtimeMs);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("write refuses to overwrite a secret with the placeholder", async () => {
    const result = await createWriteTool(tmpDir, tracker).execute(
      { file_path: ".env", content: MODEL_VIEW.replace("true", "false") },
      ctx,
    );
    expect(String(result)).toMatch(/^Error: Refused/);
    expect(await fs.readFile(envPath, "utf-8")).toBe(ENV_FILE);
  });

  it("edit that avoids the hidden line succeeds and keeps the secret", async () => {
    await createEditTool(tmpDir, tracker).execute(
      { file_path: ".env", edits: [{ old_text: "DEBUG=true", new_text: "DEBUG=false" }] },
      ctx,
    );
    expect(await fs.readFile(envPath, "utf-8")).toBe(`OPENAI_API_KEY=${SECRET}\nDEBUG=false\n`);
  });

  it("edit targeting the placeholder explains why it cannot match", async () => {
    await expect(
      createEditTool(tmpDir, tracker).execute(
        {
          file_path: ".env",
          edits: [{ old_text: `OPENAI_API_KEY=${REDACTION_MARKER}`, new_text: "OPENAI_API_KEY=x" }],
        },
        ctx,
      ),
    ).rejects.toThrow(/hidden credentials appear in tool output/);
    expect(await fs.readFile(envPath, "utf-8")).toBe(ENV_FILE);
  });

  it("edit refuses to add the placeholder into a file with hidden values", async () => {
    await expect(
      createEditTool(tmpDir, tracker).execute(
        {
          file_path: ".env",
          edits: [{ old_text: "DEBUG=true", new_text: `GITHUB_TOKEN=${REDACTION_MARKER}` }],
        },
        ctx,
      ),
    ).rejects.toThrow(/Refused/);
    expect(await fs.readFile(envPath, "utf-8")).toBe(ENV_FILE);
  });
});
