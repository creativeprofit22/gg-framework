import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { SessionManager } from "./session-manager.js";
import {
  appendMessagesToSession,
  createCompactedSessionCheckpoint,
  formatRestoreInfoText,
  getRestoredMessagesForDisplay,
  sourceFingerprint,
} from "./session-compaction.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-session-compaction-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function message(role: Message["role"], content: string): Message {
  return { role, content } as Message;
}

describe("session compaction persistence", () => {
  it("writes compacted checkpoints to a fresh session without persisting system messages", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const messages = [
      message("system", "system prompt"),
      message("user", "[Previous conversation summary]\nsummary"),
      message("assistant", "ack"),
      message("user", "recent request"),
    ];

    const checkpoint = await createCompactedSessionCheckpoint(manager, {
      cwd: "/repo",
      provider: "openai",
      model: "gpt-5",
      messages,
      conversationId: "original-conversation",
      generation: 3,
      parentSessionId: "parent-checkpoint",
      sourceFingerprint: "f".repeat(64),
      retainedMessageCount: 1,
      title: "Stable project title",
    });

    const loaded = await manager.load(checkpoint.path);
    const loadedMessages = manager.getMessages(loaded.entries);

    expect(loaded.header.cwd).toBe("/repo");
    expect(loaded.header.provider).toBe("openai");
    expect(loaded.header.model).toBe("gpt-5");
    expect(loaded.header.conversationId).toBe("original-conversation");
    expect(loaded.header.generation).toBe(3);
    expect(loaded.header.parentSessionId).toBe("parent-checkpoint");
    expect(loaded.header.sourceFingerprint).toBe("f".repeat(64));
    expect(loaded.header.retainedMessageCount).toBe(1);
    expect(loaded.header.preview).toBe("Stable project title");
    expect(loaded.entries.find((entry) => entry.type === "label")?.label).toBe(
      "Stable project title",
    );
    expect(loadedMessages).toEqual(messages.slice(1));

    const file = await readFile(checkpoint.path, "utf-8");
    expect(file).not.toContain("system prompt");
    expect(file).toContain("[Previous conversation summary]");
  });

  it("fingerprints provenance as part of the non-system compaction source", () => {
    const base: Message = { role: "user", content: "same text" };
    const tagged: Message = {
      ...base,
      provenance: { source: "runtime", kind: "automation", visibility: "hidden" },
    };
    expect(sourceFingerprint([message("system", "one"), base])).toBe(
      sourceFingerprint([message("system", "different"), base]),
    );
    expect(sourceFingerprint([base])).not.toBe(sourceFingerprint([tagged]));
  });

  it("appends only messages at and after the requested start index", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "anthropic", "claude-sonnet-4-5");
    const messages = [
      message("system", "system prompt"),
      message("user", "already persisted"),
      message("assistant", "new answer"),
      message("user", "new request"),
    ];

    await appendMessagesToSession(manager, session.path, messages, 2);

    const loaded = await manager.load(session.path);
    expect(manager.getMessages(loaded.entries)).toEqual(messages.slice(2));
  });

  it("builds restored display messages and accurate restore text after load compaction", () => {
    const restored = getRestoredMessagesForDisplay([
      message("system", "system prompt"),
      message("user", "[Previous conversation summary]\nsummary"),
      message("assistant", "ack"),
    ]);

    expect(restored.map((msg) => msg.role)).toEqual(["user", "assistant"]);
    expect(formatRestoreInfoText(20, restored.length)).toBe(
      "↻ Restored compacted session (20 → 2 messages)",
    );
    expect(formatRestoreInfoText(2, 2)).toBe("↻ Restored session (2 messages)");
  });
});
