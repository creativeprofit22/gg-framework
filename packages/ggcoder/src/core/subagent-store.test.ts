import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubAgentStore, type PersistedSubAgentRecord } from "./subagent-store.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-subagent-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.GG_SUBAGENT_TEST_SECRET;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function record(index: number, output = `output-${index}`): PersistedSubAgentRecord {
  return {
    agent_id: `agent-${index}`,
    task_name: `task-${index}`,
    state: "completed",
    started_at: index,
    updated_at: index + 1,
    elapsed_ms: 1,
    turn_count: 1,
    tool_use_count: 1,
    token_usage: { input: 2, output: 3 },
    output,
    child_session_id: `session-${index}`,
    child_session_path: `/sessions/${index}.jsonl`,
  };
}

describe("SubAgentStore", () => {
  it("atomically creates mode-0600 bounded redacted state", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);
    const secret = "opaque-subagent-canary-value-123456";
    process.env.GG_SUBAGENT_TEST_SECRET = secret;
    const records = Array.from({ length: 25 }, (_, index) => record(index, `${secret}-${index}`));

    await store.save("/project", "parent-a", records);
    const filePath = store.pathFor("/project", "parent-a");
    const stat = await fs.stat(filePath);
    const directoryStat = await fs.stat(path.dirname(filePath));
    // POSIX permission bits don't exist on Windows: chmod there can only
    // toggle the read-only attribute, so Node reports 0666/0777 whatever we
    // ask for. The 0600 intent is still correct and enforced on POSIX; on
    // Windows the file is protected by the ACL it inherits from the user
    // profile instead. Assert what the platform can actually deliver rather
    // than dropping the check.
    if (process.platform === "win32") {
      expect(stat.isFile()).toBe(true);
      expect(directoryStat.isDirectory()).toBe(true);
    } else {
      expect(stat.mode & 0o777).toBe(0o600);
      expect(directoryStat.mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(filePath, "utf-8")).not.toContain(secret);
    const loaded = await store.load("/project", "parent-a");
    expect(loaded).toHaveLength(20);
    expect(loaded[0]?.agent_id).toBe("agent-5");
  });

  it("isolates project and parent session partitions", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);
    await store.save("/project-a", "parent-a", [record(1)]);
    expect(await store.load("/project-a", "parent-a")).toHaveLength(1);
    expect(await store.load("/project-b", "parent-a")).toEqual([]);
    expect(await store.load("/project-a", "parent-b")).toEqual([]);
  });

  it("lists child transcripts referenced by every durable parent and project", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);
    await store.save("/project-a", "parent-a", [record(1)]);
    await store.save("/project-a", "parent-b", [record(2)]);
    await store.save("/project-b", "parent-c", [record(3)]);

    expect(new Set(await store.listChildSessionPaths())).toEqual(
      new Set(["/sessions/1.jsonl", "/sessions/2.jsonl", "/sessions/3.jsonl"]),
    );
  });
  it("uses collision-resistant parent filenames", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);

    expect(store.pathFor("/project", "parent/a")).not.toBe(store.pathFor("/project", "parent?a"));
    expect(store.pathFor("/project", "x".repeat(200))).not.toBe(
      store.pathFor("/project", `${"x".repeat(199)}y`),
    );
  });

  it("drops records with oversized untrusted fields on load", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);
    await store.save("/project", "parent-a", [record(1, "x".repeat(300_000))]);
    expect(await store.load("/project", "parent-a")).toEqual([]);
  });

  it("recovers to empty on corruption and version mismatch", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(root);
    const filePath = store.pathFor("/project", "parent-a");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not-json");
    expect(await store.load("/project", "parent-a")).toEqual([]);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 999,
        project: "/project",
        parent_session_id: "parent-a",
        records: [],
      }),
    );
    expect(await store.load("/project", "parent-a")).toEqual([]);
  });
});
