import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTurnRecord,
  readTurnRecord,
  writeTurnRecord,
  type SubagentTurnRecord,
} from "./subagent-turn-record.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-turn-record-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const completed: SubagentTurnRecord = {
  status: "completed",
  output: "result of the orphaned turn",
  model: "fast",
  turn_count: 3,
  token_usage: { input: 120, output: 40 },
  completed_at: Date.now(),
};

describe("subagent turn record", () => {
  it("round-trips a written record", async () => {
    const root = await tempDir();
    const sessionPath = path.join(root, "child.jsonl");
    await writeTurnRecord(sessionPath, completed);
    const record = await readTurnRecord(sessionPath);
    expect(record).toEqual(completed);
  });

  it("stores the record as a sibling of the session file", async () => {
    const root = await tempDir();
    const sessionPath = path.join(root, "child.jsonl");
    await writeTurnRecord(sessionPath, completed);
    expect(await fs.readFile(`${sessionPath}.turn.json`, "utf-8")).toContain('"status"');
  });

  it("reads absent, malformed and oversized records as undefined (fail closed)", async () => {
    const root = await tempDir();
    const sessionPath = path.join(root, "child.jsonl");
    expect(await readTurnRecord(sessionPath)).toBeUndefined(); // absent
    expect(await readTurnRecord(undefined)).toBeUndefined(); // no session path

    await fs.writeFile(`${sessionPath}.turn.json`, "{not json", "utf-8");
    expect(await readTurnRecord(sessionPath)).toBeUndefined(); // malformed

    await fs.writeFile(
      `${sessionPath}.turn.json`,
      JSON.stringify({ ...completed, output: "x".repeat(2 * 1024 * 1024) }),
      "utf-8",
    );
    expect(await readTurnRecord(sessionPath)).toBeUndefined(); // oversize rejected
  });

  it("rejects records with missing required fields", async () => {
    const root = await tempDir();
    const sessionPath = path.join(root, "child.jsonl");
    await fs.writeFile(
      `${sessionPath}.turn.json`,
      JSON.stringify({ status: "completed", output: "no counts" }),
      "utf-8",
    );
    expect(await readTurnRecord(sessionPath)).toBeUndefined();
  });

  it("clears a record and tolerates clearing twice", async () => {
    const root = await tempDir();
    const sessionPath = path.join(root, "child.jsonl");
    await writeTurnRecord(sessionPath, completed);
    await clearTurnRecord(sessionPath);
    await clearTurnRecord(sessionPath);
    expect(await readTurnRecord(sessionPath)).toBeUndefined();
  });

  it("never throws when the record cannot be written", async () => {
    // An unwritable target must never reject: the turn it describes is more
    // important than the record. (mkdir recursive means this path usually
    // succeeds instead — either outcome must resolve, never throw.)
    const root = await tempDir();
    const sessionPath = path.join(root, "no-such-dir", "child.jsonl");
    await expect(writeTurnRecord(sessionPath, completed)).resolves.toBeUndefined();
  });
});
