import { randomUUID } from "node:crypto";
import type { Message } from "@kenkaiiii/gg-ai";
import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

it("restores only enhancement highlights that satisfy the shared prompt-meta contract", async () => {
  await withRealSidecar(async ({ project, manager, open, request }) => {
    const saved = await manager.create(project, "openai", "gpt-5", {
      openAICodexContextProfile: "stable",
    });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const valid = [
      { kind: "text", text: "Use " },
      { kind: "term", text: "TypeScript", original: "type script", note: "Language name" },
    ];
    // A foreign/truncated marker: the term lacks `original`, and a kind is unknown.
    const malformed = [
      { kind: "text", text: "Use " },
      { kind: "term", text: "Rust" },
      { kind: "future", text: "!" },
    ];
    const messages: Message[] = [
      { role: "user", content: "Use type script" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "Use rust" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    let parentId: string | null = null;
    for (const message of messages) {
      const id = randomUUID();
      await manager.appendRequiredMessage(saved.path, {
        type: "message",
        id,
        parentId,
        timestamp,
        message,
      });
      parentId = id;
    }
    for (const [afterMessageCount, enhancements] of [
      [1, valid],
      [3, malformed],
    ] as const) {
      await manager.appendRequiredEntry(saved.path, {
        type: "custom",
        id: randomUUID(),
        parentId: null,
        timestamp,
        kind: "app_transcript_marker",
        data: {
          version: 1,
          kind: "user_hint",
          afterMessageCount,
          data: { kenSent: true, enhancements },
        },
      });
    }
    const pane = await open(saved.path);
    const body = (await (await request("/history", pane)).json()) as {
      history: Array<{ role: string; text: string; kenSent?: boolean; enhancements?: unknown }>;
    };
    expect(
      body.history
        .filter((row) => row.role === "user")
        .map(({ text, kenSent, enhancements }) => ({
          text,
          kenSent,
          enhancements,
        })),
    ).toEqual([
      { text: "Use type script", kenSent: true, enhancements: valid },
      // Whole list dropped, matching the live path; unrelated kenSent still survives.
      { text: "Use rust", kenSent: true, enhancements: undefined },
    ]);
  });
}, 60_000);
