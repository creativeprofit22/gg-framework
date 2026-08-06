import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@kenkaiiii/gg-agent";
import { buildJiwaTools, JiwaStore } from "./jiwa.js";

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-jiwa-test-"));
  filePath = path.join(tempDir, "nested", "chat-jiwa.json");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function context(): ToolContext {
  return { signal: new AbortController().signal, toolCallId: "test-call" };
}

describe("JiwaStore", () => {
  it("persists behavior instructions separately across store instances", async () => {
    const first = new JiwaStore({ filePath });
    const added = await first.set("Call yourself Blargo in chat.", "identity", 5);
    const id = added.entry!.id;

    const second = new JiwaStore({ filePath });
    expect(await second.list()).toEqual([
      expect.objectContaining({ id, category: "identity", importance: 5 }),
    ]);

    await second.update(id, "Your name is Blargo.", "identity", 5);
    expect((await first.list())[0]?.text).toBe("Your name is Blargo.");
    expect((await first.forget(id)).deleted).toBe(true);
    expect(await second.list()).toEqual([]);
  });

  it("injects Jiwa as active behavior while preserving instruction priority", async () => {
    const store = new JiwaStore({ filePath });
    await store.set("Use concise, scannable lines.", "voice", 4);
    await store.set("Do not end replies with generic offers to help.", "boundaries", 5);

    const prompt = store.renderForPrompt();
    expect(prompt).toContain("# Jiwa");
    expect(prompt).toContain("## voice");
    expect(prompt).toContain("## boundaries");
    expect(prompt).toContain("higher-priority instruction conflicts");
    expect(prompt).toMatch(/\[[0-9a-f-]+\] \(importance 4\) Use concise, scannable lines\./);
  });

  it("rejects near-duplicate behavior instructions", async () => {
    const store = new JiwaStore({ filePath });
    const original = await store.set("Always use short direct replies", "voice");
    const duplicate = await store.set("Always use direct short replies", "voice");

    expect(duplicate.duplicateOf?.id).toBe(original.entry?.id);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("Jiwa tools", () => {
  it("are sequential and mutate only the Jiwa store", async () => {
    const store = new JiwaStore({ filePath });
    const tools = buildJiwaTools(store);
    expect(tools.map((tool) => [tool.name, tool.executionMode])).toEqual([
      ["set_jiwa", "sequential"],
      ["update_jiwa", "sequential"],
      ["forget_jiwa", "sequential"],
    ]);

    expect(
      await tools[0]!.execute(
        { content: "Call yourself Blargo.", category: "identity", importance: 5 },
        context(),
      ),
    ).toMatch(/^Set Jiwa entry /);
    const id = (await store.list())[0]!.id;

    expect(await tools[1]!.execute({ id, content: "Your name is Blargo." }, context())).toBe(
      `Updated Jiwa entry ${id}. 1 Jiwa entry stored.`,
    );
    expect(await tools[2]!.execute({ id }, context())).toBe(
      `Forgot Jiwa entry ${id}. 0 Jiwa entries remain.`,
    );
  });
});
