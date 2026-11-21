/**
 * Replay invariant: history re-derived from the persisted session log equals
 * the message array the provider actually received (deepseek-harness takeaway
 * #1 — "model-visible means logged", the reconstruction half).
 *
 * A scripted palsu factory CAPTURES the request messages on every call (the
 * sent side). The same session file is then re-loaded through the resume path
 * (`SessionManager.load` + `getMessages`) and the derived history is compared
 * against the final captured request. Divergence means something reached the
 * model without being persisted (or persisted differently) — a resumed or
 * replayed session would show the model a history that never happened.
 *
 * Documented, deliberate divergences between log and request:
 *  - `MAX_PERSISTED_TOOL_TEXT_CHARS` (40k) truncation of oversized tool text
 *    at persist time (session-storage.ts). Kept out of this test's happy path
 *    by keeping tool results small; the exemption is named here so a future
 *    failure can be checked against it.
 *  - Externalized media / display-only rows — not exercised here.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPalsuProvider, type PalsuProviderHandle } from "@kenkaiiii/gg-ai";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type * as CompactorModule from "./compaction/compactor.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, shouldCompact: shouldCompactMock, compact: compactMock };
});

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let palsu: PalsuProviderHandle;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-replay-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-replay-project-"));
  restoreHome = useFakeHome(tmpHome);
  palsu = registerPalsuProvider();
  shouldCompactMock.mockReset().mockReturnValue(false);
  compactMock.mockReset();

  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      palsu: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  palsu.unregister();
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("session log reconstructs exactly what the model received", () => {
  it("derived history equals the final captured request", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const { SessionManager } = await import("./session-manager.js");

    // Every request the provider saw, deep-cloned at call time (the loop
    // mutates its message array in place, so references alone would all show
    // the final state). Each scripted reply is a factory that captures the
    // request and returns the next scripted assistant message.
    const capturedRequests: Message[][] = [];
    const replies = [
      { content: [{ type: "tool_call" as const, id: "call_1", name: "boom", args: {} }] },
      { content: [{ type: "text" as const, text: "Recovered after the failed call." }] },
    ];
    palsu.setResponses(
      replies.map((reply) => (messages: Message[]) => {
        capturedRequests.push(structuredClone(messages));
        return { role: "assistant" as const, ...reply };
      }),
    );

    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    session.queueMessage("Steering: keep going."); // drained at the loop's initial poll
    await session.prompt("Do the task.");
    const sessionPath = session.getState().sessionPath; // before dispose() clears it
    await session.dispose();

    // The run must have made multiple requests (user→tool-call, then result).
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const finalRequest = capturedRequests[capturedRequests.length - 1];

    // Re-derive history exactly as resume does.
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const { entries } = await manager.load(sessionPath);
    const derived = manager.getMessages(entries);

    // The final request = [system, ...history]; getMessages drops the system
    // row (resume re-attaches a freshly built system prompt).
    // `provenance` is the ONE documented exemption: log-side bookkeeping
    // (source/kind/visibility) that persistence adds and the wire strips —
    // it never reaches the model, so the model-visible comparison drops it.
    const stripProvenance = (messages: Message[]): unknown[] =>
      messages.filter((m) => m.role !== "system").map(({ provenance: _p, ...rest }) => rest);
    const derivedRows = stripProvenance(derived);
    const sentRows = stripProvenance(finalRequest);
    // The final assistant reply is persisted AFTER the last request (it IS the
    // response to it), so the derived history = sent history + that reply.
    expect(derivedRows.slice(0, sentRows.length)).toEqual(sentRows);
    expect(derivedRows.length).toBe(sentRows.length + 1); // exactly one trailing reply
    expect((derivedRows[derivedRows.length - 1] as { role: string }).role).toBe("assistant");
  }, 60_000);
});
