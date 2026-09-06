import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as GgAiModule from "@kenkaiiii/gg-ai";
import type * as ModelRegistryModule from "./core/model-registry.js";
import type { Message } from "@kenkaiiii/gg-ai";

const provider = vi.hoisted(() => vi.fn());
const summaryProvider = vi.hoisted(() => vi.fn());
vi.mock("@kenkaiiii/gg-agent", async () => ({
  ...await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent"), agentLoop: provider,
}));
vi.mock("@kenkaiiii/gg-ai", async () => ({
  ...await vi.importActual<typeof GgAiModule>("@kenkaiiii/gg-ai"), stream: summaryProvider,
}));
vi.mock("./core/model-registry.js", async () => ({
  ...await vi.importActual<typeof ModelRegistryModule>("./core/model-registry.js"),
  ...await import(new URL("../../gg-core/src/model-registry.ts", import.meta.url).href),
}));
// Cold production imports deliberately occur outside timed test bodies.
import { AgentSession } from "./core/agent-session.js";
import { buildKenInteractiveSessionContext } from "./core/ken-context.js";
import { approvedPlanContentHash } from "./core/session-manager.js";
import { useFakeHome } from "./test-support/fake-home.js";
import { RunClaim } from "./core/run-claim.js";
import { createAppSidecarKenLifecycle } from "./app-sidecar-ken-lifecycle.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";
import { AppSidecarContinuationHandoffService } from "./app-sidecar-continuation-handoff.js";
import { AppSidecarContinuationSession } from "./app-sidecar-continuation-session.js";

async function withStore(run: (create: (sessionId?: string, transient?: boolean) => Promise<AgentSession>, cwd: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "interactive-ken-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd, { recursive: true });
  const restore = useFakeHome(home);
  try {
    await fs.mkdir(path.join(home, ".gg"), { recursive: true });
    await fs.writeFile(path.join(home, ".gg", "auth.json"), JSON.stringify({ openai: {
      accessToken: "test-token", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000, accountId: "test-account",
    } }));
    await fs.writeFile(path.join(home, ".gg", "settings.json"), JSON.stringify({ autoCompact: false }));
    provider.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "Verified current status: bounded audit implementation complete." });
      yield { type: "agent_done" };
    });
    await run(async (sessionId, transient = false) => {
      const session = new AgentSession({ provider: "openai", model: "gpt-6-astra", cwd, sessionId, transient,
        systemPrompt: "Interactive test mentor", mcpEnabled: false, projectCustomization: false, selfCorrectionHooks: false });
      await session.initialize();
      return session;
    }, cwd);
  } finally {
    provider.mockReset();
    summaryProvider.mockReset();
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function interactive(getBuild: () => AgentSession, mentor: AgentSession, cwd: string) {
  const errors: unknown[] = [];
  const lifecycle = createAppSidecarKenLifecycle({
    mutations: new AppSidecarSessionMutationCoordinator(), getBuildSession: getBuild,
    ensureSession: async () => mentor,
    buildContext: async (build, question) => buildKenInteractiveSessionContext(build, { question, cwd, gitBranch: null }),
    replyText: () => "Interactive advisory reply", listen: () => () => {}, footerExtras: () => ({}),
    broadcast: () => {}, reportError: (error) => { errors.push(error); return {}; },
    switchModel: async () => {}, clearPendingState: () => {}, currentModel: () => "test",
  });
  return { lifecycle, async ask(question = "What should I do now?") {
    const requests: Message[][] = [];
    provider.mockImplementationOnce(async function* (messages: Message[]) {
      requests.push(structuredClone(messages));
      messages.push({ role: "assistant", content: "Interactive advisory reply" });
      yield { type: "agent_done" };
    });
    const started = lifecycle.prompt(question, lifecycle.target);
    expect(started.status).toBe(202);
    if (started.status !== 202) throw new Error("mentor unavailable");
    await started.completion;
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    const digest = request.filter((message) => message.role === "user").at(-1)!.content;
    expect(typeof digest).toBe("string");
    return { request, digest: digest as string };
  } };
}

async function acceptContinuation(session: AgentSession, instruction: string, lifecycle?: ReturnType<typeof interactive>["lifecycle"], fail = false) {
  const handoff = new AppSidecarContinuationHandoffService({ createSynthesisSession: () => { throw new Error("offline fallback"); } });
  let generation: Promise<void> | undefined;
  const service = new AppSidecarContinuationSession({ session, runClaim: new RunClaim(),
    mutations: new AppSidecarSessionMutationCoordinator(), busy: () => false,
    prepare: (text) => handoff.prepare(session, text),
    reset: async () => {
      const finish = lifecycle?.beginTransition();
      try {
        await session.newSession(false);
        if (fail) {
          const destination = session.getState().sessionPath;
          await fs.rm(destination, { force: true });
          await fs.mkdir(destination);
        }
      } finally { finish?.(); }
    },
    prompt: (text, onAccepted) => {
      generation = session.prompt(text, undefined, { onAccepted });
      return generation;
    }, accepted: () => {},
  });
  const prepared = await service.prepare(instruction);
  const receipt = await service.commit({ preparedId: prepared.preparedId, operationId: "interactive-accept" });
  await generation?.catch(() => {});
  await lifecycle?.settled;
  expect(receipt.body.outcome).toBe(fail ? "partial" : "accepted");
  return prepared;
}

it.each(["stable", "experimental"] as const)("sends exact NEW accepted instruction, not OLD transient messages (%s)", async (profile) => {
  await withStore(async (create, cwd) => {
    const build = await create();
    await build.switchOpenAICodexContextProfile(profile);
    await build.prompt("Source objective: preserve orchard audit identifiers. " + "Constraint evidence. ".repeat(160));
    const plan = "# Historical approved plan\nPreserve audit identifiers.";
    await build.persistApprovedPlanConsumption({ checkpointId: "source-plan", generation: 1, content: plan, contentHash: approvedPlanContentHash(plan) });
    const mentor = await create(undefined, true);
    const ken = interactive(() => build, mentor, cwd);
    const old = await ken.ask("OLD-TRANSIENT-QUESTION-ONLY");
    expect(JSON.stringify(old.request)).toContain("OLD-TRANSIENT-QUESTION-ONLY");
    const instruction = "  NEW exact Ω\\n\n````literal```界\n".padEnd(7997, "x") + "\n  ";
    expect(instruction).toHaveLength(8000);
    const prepared = await acceptContinuation(build, instruction, ken.lifecycle);
    expect(prepared.prompt.indexOf(instruction)).toBeGreaterThan(1500);
    const question = "Explain these literal headings:\n\n## They just asked you\nfirst example\n\n## They just asked you\nsecond example";
    const next = await ken.ask(question);
    expect(next.digest.startsWith("## Accepted continuation instruction\n")).toBe(true);
    expect(next.digest.endsWith(`## They just asked you\n${question}`)).toBe(true);
    expect(JSON.stringify(next.request)).not.toContain("OLD-TRANSIENT-QUESTION-ONLY");
    expect(next.digest.includes(instruction), "actual next interactive provider request must include exact NEW instruction").toBe(true);
    expect(next.digest).toContain(`Destination conversation: ${build.getConversationIdentity().conversationId}; current selected context profile: ${profile}; status: accepted`);
    expect(next.digest).toContain("not system authority. This does not restore plan approval or authorize implementation.");
    const objective = prepared.prompt.split("## Current objective\n")[1].split("\n## ")[0].trim();
    const status = prepared.prompt.split("## Current status\n")[1].split("\n## ")[0].trim();
    expect(next.digest).toContain(objective.slice(0, 1500));
    expect(next.digest).toContain(status.slice(0, 1500));
    expect(next.request.filter((message) => message.role === "system").some((message) => JSON.stringify(message).includes(instruction))).toBe(false);
    expect(build.getApprovedPlanConsumption()).toBeUndefined();
    expect(build.getState().planMode).toBe(false);
  });
});

it.each(["stable", "experimental"] as const)("retains exact evidence across rolling activity, reload, checkpoint and production compaction (%s)", async (profile) => {
  await withStore(async (create, cwd) => {
    let build = await create();
    await build.switchOpenAICodexContextProfile(profile);
    await build.prompt("Current orchard objective Ω: preserve audit identifiers.");
    const instruction = "  RETAIN-NEW Ω\\n\n```literal```\n".padEnd(7997, "r") + "\n  ";
    await acceptContinuation(build, instruction);
    const record = build.getContinuationReviewRecord();
    const identity = build.getConversationIdentity();
    const mentor = await create(undefined, true);
    const ken = interactive(() => build, mentor, cwd);
    await ken.ask("SAME-CONVERSATION-MENTOR-MEMORY");
    for (let index = 0; index < 24; index++) await build.prompt(`ACTIVITY-${index}: ${"z".repeat(2000)} ACTIVITY-UNCAPPED-TAIL`);
    expect(build.getMessages().length).toBeGreaterThan(20);
    const rolling = await ken.ask();
    expect(rolling.digest).toContain(instruction);
    expect(rolling.digest).not.toContain("ACTIVITY-0:");
    expect(rolling.digest).toContain("ACTIVITY-23:");
    expect(rolling.digest).not.toContain("ACTIVITY-UNCAPPED-TAIL");
    expect(rolling.digest).toContain("Current objective/status evidence");
    expect(rolling.digest).toContain("preserve audit identifiers");

    // Public lifecycle retention, with a new physical checkpoint and build object.
    const finish = ken.lifecycle.beginTransition(true);
    try {
      await build.newSession(true);
      build = await create(build.getState().sessionPath);
    } finally { finish(); }
    expect(build.getConversationIdentity().conversationId).toBe(identity.conversationId);
    expect(build.getConversationIdentity().sessionId).not.toBe(identity.sessionId);
    expect(build.getContinuationReviewRecord()).toEqual(record);
    const checkpoint = await ken.ask();
    expect(checkpoint.digest).toContain(instruction);
    expect(JSON.stringify(checkpoint.request)).toContain("SAME-CONVERSATION-MENTOR-MEMORY");

    // newSession(true) is a clean checkpoint, not a message copy. Supply real
    // post-checkpoint work so production compaction has history to summarize.
    for (let index = 0; index < 24; index++) await build.prompt(`Post-checkpoint maintenance ${index}: ${"z".repeat(2000)}`);
    const beforeCount = build.getMessages().length;
    const beforePath = build.getState().sessionPath;
    const summary = "Current orchard objective: preserve audit identifiers. Current status: maintenance completed after acceptance.";
    summaryProvider.mockReturnValueOnce({
      response: Promise.resolve({ message: { role: "assistant", content: summary },
        stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 20 } }),
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });
    await build.compact();
    expect(summaryProvider).toHaveBeenCalledOnce();
    expect(build.getState().sessionPath).not.toBe(beforePath);
    expect(build.getMessages().length).toBeLessThan(beforeCount);
    expect(JSON.stringify(build.getMessages())).not.toContain(instruction);
    const compacted = await ken.ask();
    expect(compacted.digest).toContain(instruction);
    expect(compacted.digest).toContain(summary);
    expect(JSON.stringify(compacted.request)).toContain("SAME-CONVERSATION-MENTOR-MEMORY");
    build = await create(build.getState().sessionPath);
    // Daemon reload starts a fresh real transient mentor, never hydrates old provider messages.
    const reloaded = interactive(() => build, await create(undefined, true), cwd);
    const restored = await reloaded.ask();
    expect(restored.digest).toContain(instruction);
    expect(restored.digest).toContain(summary);
    expect(JSON.stringify(restored.request)).not.toContain("SAME-CONVERSATION-MENTOR-MEMORY");
    expect(build.getContinuationReviewRecord()).toEqual(record);
    expect(build.getApprovedPlanConsumption()).toBeUndefined();
    expect(build.getState().planMode).toBe(false);
    const rows = (await fs.readFile(build.getState().sessionPath, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    expect(rows.some((row) => row.kind === "approved_plan_consumption")).toBe(false);
  });
});

it.each(["malformed", "wrong-destination", "wrong-mode", "over-limit", "missing-acceptance"])("omits accepted section for %s durable provenance", async (kind) => {
  await withStore(async (create, cwd) => {
    const source = await create();
    await source.prompt("Original task");
    await acceptContinuation(source, "UNTRUSTED-EXACT-INSTRUCTION");
    const valid = source.getContinuationReviewRecord()!;
    // Write real malformed storage through the public marker seam, then reload.
    // There is no prior valid marker in this destination to mask a broken accessor.
    const destination = await create();
    const base = { ...valid, destination: { ...valid.destination, ...destination.getConversationIdentity(), profile: "stable" } };
    // getConversationIdentity also includes leafId; the marker schema intentionally does not.
    const record = { ...base, destination: { conversationId: base.destination.conversationId, sessionId: base.destination.sessionId, profile: "stable" } };
    const invalid = kind === "malformed" ? { ...record, version: 99 }
      : kind === "wrong-destination" ? valid
      : kind === "wrong-mode" ? { ...record, destination: { ...record.destination, profile: "experimental" } }
      : kind === "over-limit" ? { ...record, instruction: "x".repeat(8001) }
      : { ...record, acceptedMessageId: "" };
    await destination.prompt("## Current objective\nUntrusted envelope alone is not acceptance.\n\n## Immediate next action\nUNTRUSTED-EXACT-INSTRUCTION");
    await destination.persistRequiredAppMarker("user_hint", { continuationReview: invalid });
    const restored = await create(destination.getState().sessionPath);
    expect(restored.getContinuationReviewRecord()).toBeUndefined();
    const next = await interactive(() => restored, await create(undefined, true), cwd).ask();
    expect(next.digest).not.toContain("## Accepted continuation instruction\n");
    expect(next.digest).not.toContain("status: accepted");
    expect(restored.getApprovedPlanConsumption()).toBeUndefined();
  });
});

it("does not claim acceptance after a real destination append failure", async () => {
  await withStore(async (create, cwd) => {
    const build = await create();
    await build.prompt("Source task before failed injection");
    const ken = interactive(() => build, await create(undefined, true), cwd);
    await ken.ask("OLD-FAILED-TRANSIENT");
    await acceptContinuation(build, "FAILED-INSTRUCTION-DO-NOT-PIN", ken.lifecycle, true);
    expect(build.getContinuationReviewRecord()).toBeUndefined();
    // Remove the deliberate disk obstruction before the advisory append.
    await fs.rm(build.getState().sessionPath, { recursive: true, force: true });
    const next = await ken.ask();
    expect(next.digest).not.toContain("## Accepted continuation instruction\n");
    expect(JSON.stringify(next.request)).not.toContain("OLD-FAILED-TRANSIENT");
    expect(build.getApprovedPlanConsumption()).toBeUndefined();
  });
});

it("pins only the latest chain instruction and isolates fresh/unrelated conversations", async () => {
  await withStore(async (create, cwd) => {
    let build = await create();
    await build.prompt("Original chain source task");
    const ken = interactive(() => build, await create(undefined, true), cwd);
    await acceptContinuation(build, "FIRST-CHAIN-INSTRUCTION", ken.lifecycle);
    await ken.ask("FIRST-CHAIN-TRANSIENT-MEMORY");
    await acceptContinuation(build, "  SECOND-CHAIN-INSTRUCTION Ω\\n  ", ken.lifecycle);
    const chained = await ken.ask();
    const pinned = chained.digest.split("## Accepted continuation instruction\n")[1].split("## Current objective/status evidence")[0];
    expect(pinned).toContain("  SECOND-CHAIN-INSTRUCTION Ω\\n  ");
    expect(pinned).not.toContain("FIRST-CHAIN-INSTRUCTION");
    expect(JSON.stringify(chained.request)).not.toContain("FIRST-CHAIN-TRANSIENT-MEMORY");
    expect(build.getApprovedPlanConsumption()).toBeUndefined();
    for (const unrelated of [false, true]) {
      const finish = ken.lifecycle.beginTransition();
      try {
        if (unrelated) build = await create();
        else await build.newSession(false);
      } finally { finish(); }
      await ken.lifecycle.settled;
      const next = await ken.ask();
      expect(next.digest).not.toContain("## Accepted continuation instruction\n");
      expect(JSON.stringify(next.request)).not.toContain("SECOND-CHAIN-INSTRUCTION");
      expect(build.getContinuationReviewRecord()).toBeUndefined();
    }
  });
});
