import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProgrammaticProfileTool } from "./tools/programmatic-profile.js";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createAskUserBridge, type AskUserPrompt } from "./core/ask-user.js";
import { withRealSidecar } from "./test-support/real-sidecar.js";
import { createAskUserTool } from "./tools/ask-user.js";
import { commandCreationReviewer } from "./core/programmatic/command-creation.js";

/**
 * A prompt typed while a question is on screen is the user's answer: they chose
 * to say something else instead of clicking. `POST /prompt` therefore has to
 * release the parked `ask_user` call BEFORE it decides what to do with the
 * text.
 *
 * Order is the whole bug. Steering only drains between tool calls, so a prompt
 * queued while the tool is still parked waits on a tool that is itself waiting
 * on the user — the turn sits frozen until the ten-minute ask timeout fires,
 * and the user's message lands ten minutes late.
 *
 * The route lives inside app-sidecar's single `main()` closure with no seam to
 * inject a bridge into, so this covers it from both sides: the release itself
 * is exercised for real against a real parked tool call, and the route's source
 * is checked for where that release sits relative to the queue.
 */
const APP_SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app-sidecar.ts");

/** The brace-balanced body of a route handler, keyed by its `url ===` guard. */
function routeBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `route not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return source.slice(start, end + 1);
}

describe("reviewed command questions use the existing desktop bridge", () => {
  it("recovers missed question and settlement over real source-daemon HTTP/SSE", async () => {
    await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
      const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
      const sessionId = await open(saved.path, "chat");
      const observer = await subscribe(sessionId);
      expect(observer.events[0]!.data.pendingAsks).toEqual([]);
      expect((await request("/prompt", sessionId, { text: "Ask for approval" })).status).toBe(202);
      const question = (await observer.waitFor("ask_user")).data;
      const lateClient = await subscribe(sessionId);
      expect(lateClient.events.filter((event) => event.type === "ask_user")).toEqual([]);
      expect((await lateClient.waitFor("ready")).data.pendingAsks).toEqual([question]);
      expect((await (await request("/state", sessionId)).json()).pendingAsks).toEqual([question]);
      expect(observer.events.filter((event) => event.type === "ask_user_settled")).toEqual([]);
      // The recovered display itself cannot settle anything; only this separate POST can.
      const receipt = await request(`/ask/${question.id}`, sessionId, { action: "cancel" });
      expect(receipt.status).toBe(200);
      expect(await receipt.json()).toEqual({ ok: true });
      await observer.waitFor("ask_user_settled");
      const afterMissedSettlement = await subscribe(sessionId);
      expect((await afterMissedSettlement.waitFor("ready")).data.pendingAsks).toEqual([]);
      const expired = await request(`/ask/${question.id}`, sessionId, { action: "cancel" });
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({ error: "no question is awaiting an answer" });
    }, { parkQuestion: true });
  }, 60_000);
  it("projects live asks through the same state snapshot used by SSE ready and GET state", async () => {
    const source = await fs.readFile(APP_SIDECAR, "utf8");
    const snapshot = routeBlock(source, "function stateSnapshot()");
    expect(snapshot).toContain("pendingAsks: asks.pendingRequests");
    expect(source).toContain('res.write(sseFrame("ready", stateSnapshot()))');
    expect(source).toContain('json(res, 200, stateSnapshot())');
  });
  it("recovers a parked creation review exactly while still requiring a separate answer", async () => {
    const broadcast = vi.fn();
    const asks = createAskUserBridge({ broadcast });
    const request = { questions: [{ id: "creation-review", kind: "choice" as const,
      question: "Create exactly these files?", detail: "Complete preview\n+ file", allowOther: false,
      options: [{ label: "Create reviewed files", value: "host-exact-content-nonce" },
        { label: "Do not create files", value: "reject", recommended: true }] }] };
    const completed = vi.fn();
    const review = commandCreationReviewer(asks)(request, new AbortController().signal).then(completed);
    const recovered = asks.pendingRequests;
    expect(recovered).toEqual([broadcast.mock.calls[0]![0]]);
    expect(recovered[0]!.questions).toEqual(request.questions);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(asks.pendingRequests).toEqual(recovered);
    asks.settle(recovered[0]!.id, { action: "answer", answers: { "creation-review": "host-exact-content-nonce" } });
    await review;
    expect(completed).toHaveBeenCalledExactlyOnceWith({ action: "answer", answers: { "creation-review": "host-exact-content-nonce" } });
    expect(asks.pendingRequests).toEqual([]);
  });
  it("cancels only its own parked review and never interprets a typed replacement as acceptance", async () => {
    const asks = createAskUserBridge({ broadcast: () => {} });
    const unrelated = asks.park({ questions: [{ id: "unrelated", kind: "confirm", question: "Keep this open?" }] });
    const abort = new AbortController();
    const review = commandCreationReviewer(asks)({ questions: [{ id: "command-review", kind: "choice", question: "Create exact bytes?", allowOther: false,
      options: [{ label: "Create", value: "host-nonce" }, { label: "Reject", value: "reject" }] }] }, abort.signal);
    expect(asks.pendingCount).toBe(2);
    abort.abort();
    expect(await review).toEqual({ action: "cancel" });
    expect(asks.pendingCount).toBe(1);
    asks.cancelAll({ action: "cancel", superseded: true });
    expect(await unrelated).toEqual({ action: "cancel", superseded: true });
    expect(asks.pendingCount).toBe(0);
  });
  it.each(["approve", "deny", "supersede", "abort"] as const)("requires an actual parked setup answer: %s", async (outcome) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-setup-review-"));
    const asks = createAskUserBridge({ broadcast: () => {} });
    const controller = new AbortController();
    const tool = createProgrammaticProfileTool(cwd, { reviewer: commandCreationReviewer(asks) });
    let running: Promise<unknown> | undefined;
    try {
      const context = { signal: controller.signal, toolCallId: "setup" };
      const proposal = JSON.parse(await tool.execute({ action: "inspect" }, context) as string);
      const input = { action: "generate" as const, configuration_fingerprint: proposal.configuration_fingerprint,
        profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest };
      running = Promise.resolve(tool.execute(input, context));
      await vi.waitFor(() => expect(asks.pendingCount).toBe(1));
      const parked = asks.pendingRequests[0]!;
      expect(parked.questions[0]!.detail).toContain("configurationFingerprint");
      await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
      if (outcome === "supersede") asks.cancelAll({ action: "cancel", superseded: true });
      else if (outcome === "abort") controller.abort();
      else asks.settle(parked.id, { action: "answer", answers: {
        [parked.questions[0]!.id]: outcome === "approve" ? "save-setup" : "deny",
      } });
      const result = JSON.parse(await running as string);
      expect(result.changed).toBe(outcome === "approve");
      expect(asks.pendingCount).toBe(0);
      if (outcome !== "approve") await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
      expect(JSON.parse(await tool.execute(input, { signal: new AbortController().signal, toolCallId: "replay" }) as string))
        .toMatchObject({ changed: false, error: expect.stringContaining("setup-proposal-unavailable") });
    } finally { controller.abort(); asks.cancelAll(); await running; tool.dispose(); await fs.rm(cwd, { recursive: true, force: true }); }
  });
  it("wires the reviewer only into the normal desktop session, not Ken", async () => {
    const source = await fs.readFile(APP_SIDECAR, "utf8");
    expect(source.match(/reviewCommandCreation: commandCreationReviewer\(asks\)/g)).toHaveLength(1);
    expect(source.match(/reviewProgrammaticSetup: commandCreationReviewer\(asks\)/g)).toHaveLength(1);
  });
});

describe("a typed prompt supersedes a parked question", () => {
  it("releases the blocked tool call with the answer-is-coming result", async () => {
    const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
    const asks = createAskUserBridge({ broadcast, timeoutMs: 600_000 });
    const tool = createAskUserTool(asks.park);
    const parked = tool.execute(
      { questions: [{ id: "store", question: "Which store for sessions?", kind: "confirm" }] },
      { signal: new AbortController().signal, toolCallId: "t1", onUpdate: () => {} } as never,
    ) as Promise<string>;
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    expect(asks.pendingCount).toBe(1);

    // Exactly what POST /prompt does with a non-empty prompt body.
    asks.cancelAll({ action: "cancel", superseded: true });

    // The turn is free immediately — no ten-minute timeout, no cancelled run.
    expect(asks.pendingCount).toBe(0);
    const text = await parked;
    expect(text).toContain("sent their own message instead");
    expect(text).not.toContain("stop and wait");
  });

  it("releases it before the prompt can queue as steering", async () => {
    const block = routeBlock(
      await fs.readFile(APP_SIDECAR, "utf8"),
      'if (method === "POST" && url === "/prompt") {',
    );
    const released = block.indexOf("superseded: true");
    const queued = block.indexOf("session.queueMessage(");
    const started = block.indexOf("runClaim.claim()");

    expect(released).toBeGreaterThan(-1);
    expect(queued).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(-1);
    // Both dispositions of a prompt — queued as steering mid-run, or claiming a
    // fresh run — must happen with the question already released.
    expect(released).toBeLessThan(queued);
    expect(released).toBeLessThan(started);
    // …but only for a prompt that actually exists: an empty body is rejected
    // above, and must not kill a live question on its way out.
    expect(block.indexOf('error: "empty prompt"')).toBeLessThan(released);
  });
});
