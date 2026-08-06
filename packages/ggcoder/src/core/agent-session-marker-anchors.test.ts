import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import {
  normalizeAppMarkersForHistory,
  normalizeAutopilotMarkersForHistory,
  normalizeKenTurnsForHistory,
} from "./session-history.js";
import { useFakeHome } from "../test-support/fake-home.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());
const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return {
    ...actual,
    shouldCompact: shouldCompactMock,
    compact: compactMock,
  };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return {
    ...actual,
    agentLoop: agentLoopMock,
  };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return {
        connectAll: vi.fn(async () => []),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
});

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function listSessionFiles(): Promise<string[]> {
  const root = path.join(tmpHome, ".gg", "sessions");
  const found: string[] = [];
  for (const dir of await fs.readdir(root)) {
    for (const file of await fs.readdir(path.join(root, dir))) {
      if (file.endsWith(".jsonl")) found.push(path.join(root, dir, file));
    }
  }
  // Session filenames lead with an ISO timestamp, so lexical order is
  // chronological — the last one is the newest (post-compaction) file.
  return found.sort();
}

async function findSessionFile(): Promise<string> {
  const found = await listSessionFiles();
  if (found.length !== 1) throw new Error(`expected 1 session file, found ${found.length}`);
  return found[0]!;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "marker-anchor-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "marker-anchor-project-"));
  restoreHome = useFakeHome(tmpHome);

  shouldCompactMock.mockReset().mockReturnValue(false);
  compactMock.mockReset();
  agentLoopMock.mockReset();

  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test" + "-access",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: true,
    compactThreshold: 0.1,
  });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("AgentSession transcript marker anchors", () => {
  it("anchors markers to the persisted prefix so a failed run's unpersisted messages cannot shift them to the bottom on resume", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    // Successful first run: user + assistant persisted (2 non-system messages).
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "first reply" });
      yield { type: "agent_done" };
    });
    await session.prompt("first task");

    // Markers recorded while the session is settled: anchor = 2.
    await session.persistAppMarker("error", { headline: "mid error" });
    await session.persistKenTurn("question", "reply");
    await session.persistAutopilotMarker("done");

    // Failed second run: the loop appends partial messages in place, then
    // throws — they stay in memory but are NEVER persisted. The user message
    // itself IS persisted (prompt persists it before the loop), so the
    // persisted transcript is user1/assistant1/user2 = 3 non-system messages.
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push(
        { role: "assistant", content: "partial draft" },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "t1", content: "partial tool output" }],
        },
        { role: "assistant", content: "more partial work" },
      );
      yield { type: "text_delta", text: "partial" };
      throw new Error("provider melted down");
    });
    await expect(session.prompt("second task")).rejects.toThrow("provider melted down");

    // The in-memory list now runs 3 messages ahead of the file. Anchoring
    // against the full in-memory list (old behavior) records 6 — past the end
    // of the restored transcript. The persisted prefix gives 3: exactly where
    // the error appeared live.
    await session.persistAppMarker("error", { headline: "late error" });

    const markers = session.getAppMarkers().filter((m) => m.kind === "error");
    expect(markers.map((m) => m.afterMessageCount)).toEqual([2, 3]);
    expect(session.getKenTurns().map((t) => t.afterMessageCount)).toEqual([2]);
    expect(session.getAutopilotMarkers().map((m) => m.afterMessageCount)).toEqual([2]);
    await session.dispose();

    // Resume: a fresh session loads the file. The restored transcript has 3
    // non-system messages; both error markers must survive normalization at
    // their original positions (2 = mid-transcript, 3 = after the failed
    // turn's user bubble) instead of being dropped as out-of-range.
    const sessionFile = await findSessionFile();
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: sessionFile,
    });
    await resumed.initialize();

    const restoredCount = resumed.getMessages().filter((m) => m.role !== "system").length;
    expect(restoredCount).toBe(3);

    const replayed = normalizeAppMarkersForHistory(resumed.getAppMarkers(), restoredCount).filter(
      (m) => m.kind === "error",
    );
    expect(replayed.map((m) => m.afterMessageCount)).toEqual([2, 3]);
    // Neither marker bunches at the bottom of the resumed transcript.
    expect(replayed.some((m) => m.afterMessageCount > restoredCount)).toBe(false);
    await resumed.dispose();
  }, 15_000);

  // The reported bug: an autopilot session that gets compacted mid-conversation
  // shows every earlier Ken verdict / error row jammed at the BOTTOM (or missing)
  // when reopened, even though several turns happened after them. Compaction
  // re-persisted the markers into the continuation file still carrying anchors
  // from the far longer pre-compaction transcript.
  it("keeps markers in place when compaction rewrites the session mid-conversation", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "reply" });
      yield { type: "agent_done" };
    });

    // Six turns (12 non-system messages), with markers recorded early on —
    // exactly the shape of an autopilot run: Ken reviews, an error surfaces,
    // and the conversation keeps going well past both.
    await session.prompt("turn 1");
    await session.prompt("turn 2");
    await session.persistAppMarker("error", { headline: "Rate limited" });
    await session.persistAutopilotMarker("done");
    await session.persistKenTurn("is this right?", "looks good");
    await session.prompt("turn 3");
    await session.prompt("turn 4");
    await session.prompt("turn 5");
    // A second, later verdict — this one lands in the tail compaction keeps
    // verbatim, so it exercises the shift branch as well as the collapse one.
    await session.persistAutopilotMarker("prompted", { body: "fix the flake" });
    await session.prompt("turn 6");

    // Markers sit at messages 4 and 10 of 12 — NOT at the end.
    expect(session.getAppMarkers().filter((m) => m.kind === "error")[0]?.afterMessageCount).toBe(4);
    expect(session.getAutopilotMarkers().map((m) => m.afterMessageCount)).toEqual([4, 10]);
    expect(session.getMessages().filter((m) => m.role !== "system").length).toBe(12);

    // Compaction collapses the first 8 non-system messages into a summary +
    // ack, keeping the last 4 verbatim: 12 → 6 non-system messages.
    const systemMsg = session.getMessages()[0]!;
    const tail = session.getMessages().slice(-4);
    compactMock.mockResolvedValue({
      messages: [
        systemMsg,
        { role: "user", content: "[Previous conversation summary]\n\nearlier work" },
        { role: "assistant", content: "I have the full context from the summary above." },
        ...tail,
      ],
      result: {
        compacted: true,
        originalCount: 13,
        newCount: 7,
        tokensBeforeEstimate: 100_000,
        tokensAfterEstimate: 10_000,
        anchorRemap: { summarizedCount: 8, prefixCount: 2, newNonSystemCount: 6 },
      },
    });
    await session.compact();

    const compactedCount = session.getMessages().filter((m) => m.role !== "system").length;
    expect(compactedCount).toBe(6);

    // Two more turns AFTER the compaction, so "the bottom" is unambiguously
    // somewhere the old markers must not be.
    await session.prompt("turn 7");
    await session.prompt("turn 8");
    await session.dispose();

    // Resume from the continuation file compaction created.
    const files = await listSessionFiles();
    expect(files.length).toBe(2);
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: files[files.length - 1]!,
    });
    await resumed.initialize();

    const restoredCount = resumed.getMessages().filter((m) => m.role !== "system").length;
    expect(restoredCount).toBe(10); // 6 compacted + 2 turns × 2 messages

    const errors = normalizeAppMarkersForHistory(resumed.getAppMarkers(), restoredCount).filter(
      (m) => m.kind === "error",
    );
    const verdicts = normalizeAutopilotMarkersForHistory(
      resumed.getAutopilotMarkers(),
      restoredCount,
    );
    const kenTurns = normalizeKenTurnsForHistory(resumed.getKenTurns(), restoredCount);

    // All of them survive the rewrite...
    expect(errors).toHaveLength(1);
    expect(verdicts).toHaveLength(2);
    expect(kenTurns).toHaveLength(1);

    // ...the ones whose surrounding conversation was summarized away land just
    // after the summary block (the earliest honest position)...
    expect(errors[0]!.afterMessageCount).toBe(2);
    expect(verdicts[0]!.afterMessageCount).toBe(2);
    expect(kenTurns[0]!.afterMessageCount).toBe(2);

    // ...and the one in the retained tail merely shifts with it: message 10 of
    // the old transcript is message 4 of the new one. Unrebased it stayed at
    // 10, which in a 10-message transcript is the very bottom — exactly the
    // reported symptom, six messages below where it belongs.
    expect(verdicts[1]!.afterMessageCount).toBe(4);

    // Nothing bunches at the end, where the four post-compaction messages live.
    for (const anchor of [
      errors[0]!.afterMessageCount,
      verdicts[0]!.afterMessageCount,
      verdicts[1]!.afterMessageCount,
      kenTurns[0]!.afterMessageCount,
    ]) {
      expect(anchor).toBeLessThan(restoredCount - 3);
    }
    await resumed.dispose();
  }, 20_000);

  // Sessions already on disk were written before the rebase existed, so their
  // anchors are still pre-compaction values. They must be rescued to their
  // file-order position rather than dropped or clamped to the bottom.
  it("heals legacy sessions whose persisted anchors survived a compaction unrebased", async () => {
    const {
      SessionManager,
      APP_MARKER_CUSTOM_KIND,
      AUTOPILOT_MARKER_CUSTOM_KIND,
      KEN_TURN_CUSTOM_KIND,
    } = await import("./session-manager.js");
    const sessionsDir = path.join(tmpHome, ".gg", "sessions");
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create(tmpProject, "anthropic", "claude-test");

    const message = (id: string, text: string) => ({
      type: "message" as const,
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user" as const, content: text },
    });
    const custom = (id: string, kind: string, data: unknown) => ({
      type: "custom" as const,
      kind,
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      data,
    });

    // Post-compaction file: 2 summary messages, then the stale markers dumped
    // by the old re-persist path (anchors from a 367-message transcript), then
    // the conversation continues to 6 messages total.
    await manager.appendEntry(created.path, message("m1", "[Previous conversation summary]"));
    await manager.appendEntry(created.path, message("m2", "ack"));
    await manager.appendEntry(
      created.path,
      // Anchor 64 overshoots the 6-message transcript entirely — previously
      // dropped, so the verdict vanished on reopen.
      custom("a1", AUTOPILOT_MARKER_CUSTOM_KIND, {
        version: 1,
        phase: "done",
        afterMessageCount: 64,
      }),
    );
    await manager.appendEntry(
      created.path,
      // Anchor 5 is still IN range but far past where the marker was written —
      // previously replayed near the bottom, below four unrelated later turns.
      custom("e1", APP_MARKER_CUSTOM_KIND, {
        version: 1,
        kind: "error",
        afterMessageCount: 5,
        data: { headline: "Rate limited" },
      }),
    );
    await manager.appendEntry(
      created.path,
      custom("k1", KEN_TURN_CUSTOM_KIND, {
        version: 1,
        question: "why did that fail?",
        reply: "transient rate limit",
        afterMessageCount: 88,
      }),
    );
    for (const i of [3, 4, 5, 6])
      await manager.appendEntry(created.path, message(`m${i}`, `t${i}`));

    const loaded = await manager.load(created.path);
    const restoredCount = manager.getMessages(loaded.entries, loaded.header.leafId).length;
    expect(restoredCount).toBe(6);

    const verdicts = normalizeAutopilotMarkersForHistory(
      manager.getAutopilotMarkers(loaded.entries, loaded.header.leafId),
      restoredCount,
    );
    const errors = normalizeAppMarkersForHistory(
      manager.getAppMarkers(loaded.entries, loaded.header.leafId),
      restoredCount,
    );
    const kenTurns = normalizeKenTurnsForHistory(
      manager.getKenTurns(loaded.entries, loaded.header.leafId),
      restoredCount,
    );

    // All three are pulled back to where they were actually written: right
    // after the summary, above the four later messages — none dropped, none
    // stacked at the bottom.
    expect(verdicts.map((m) => m.afterMessageCount)).toEqual([2]);
    expect(errors.map((m) => m.afterMessageCount)).toEqual([2]);
    expect(kenTurns.map((t) => t.afterMessageCount)).toEqual([2]);
    expect(restoredCount - 2).toBe(4);
  }, 15_000);
});
