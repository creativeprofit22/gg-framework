import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as GgAiModule from "@kenkaiiii/gg-ai";
import type * as ModelRegistryModule from "./core/model-registry.js";
import { useFakeHome } from "./test-support/fake-home.js";
import { approvedPlanContentHash } from "./core/session-manager.js";
import {
  buildKenAutopilotSessionContext,
  buildKenAutopilotPlanSessionContext,
  runKenAutopilotSessionReview,
} from "./core/ken-context.js";
import { parseContinuationReviewRecord } from "./core/continuation-review-context.js";

const summaryProvider = vi.hoisted(() => vi.fn());
vi.mock("@kenkaiiii/gg-ai", async () => ({
  ...(await vi.importActual<typeof GgAiModule>("@kenkaiiii/gg-ai")),
  stream: summaryProvider,
}));
const realSessionAgentLoop = vi.hoisted(() => vi.fn());
vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: realSessionAgentLoop };
});
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentSession } from "./core/agent-session.js";
import { RunClaim } from "./core/run-claim.js";
import { sourceFingerprint } from "./core/session-compaction.js";
import { driveAutopilotCycle } from "./core/autopilot-cycle.js";
import { isWorkflowCommandText } from "./core/autopilot-gate.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";
import { AppSidecarContinuationHandoffService } from "./app-sidecar-continuation-handoff.js";
import { AppSidecarContinuationSession } from "./app-sidecar-continuation-session.js";
import {
  createContinuationPromptAdapter,
  createStrandedQueueDrain,
  type UserTurnDeps,
} from "./app-sidecar-user-turn.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(kind = "eligible") {
  let identity = {
    conversationId: "source",
    sessionId: "source-file",
    leafId: "source-leaf" as string | null,
  };
  const messages: Message[] = [{ role: "user", content: "Implement the scoped change." }];
  const events: string[] = [];
  let cancelled = true; // A fresh turn must clear a previous cycle's cancellation.
  const build = deferred();
  const reviewer = deferred();
  const queue = deferred();
  const mutations = new AppSidecarSessionMutationCoordinator();
  const runClaim = new RunClaim();
  const state = (): ReturnType<AgentSession["getState"]> => ({
    provider: "openai",
    model: "gpt-6-astra",
    cwd: "/project",
    sessionPath: "/project/session.jsonl",
    ...identity,
    messageCount: messages.length,
    planMode: false,
    accountId: "oauth-account",
    openAICodexContextProfile: "stable",
    openAICodexContextProfileEligibility: { canChange: true },
    openAICodexFast: false,
  });
  const session = {
    getState: state,
    getMessages: () => messages,
    getApprovedPlanConsumption: () => undefined,
    getContinuationReviewRecord: () => undefined,
    persistRequiredAppMarker: vi.fn(async () => {}),
    getConversationIdentity: () => ({ ...identity }),
    getContinuationSourceRevision: () => ({
      ...identity,
      fingerprint: sourceFingerprint(messages),
    }),
    switchOpenAICodexContextProfile: vi.fn(async () => {}),
  };
  const review = vi.fn(async () => {
    events.push("review");
    await reviewer.promise;
    return kind === "review-failure" ? null : { kind: "all_clear" as const };
  });
  const resetReviewer = vi.fn(async () => {});
  const drainQueue = vi.fn(async () => {
    events.push("queue");
    await queue.promise;
  });
  const coordinatedDrain = createStrandedQueueDrain(() => false, drainQueue);
  const runAgent = vi.fn(async (_text: string, run: () => Promise<void>) => {
    // Match production's swallowed provider failure.
    if (kind === "skipped-callback") return;
    try {
      await run();
    } catch {
      /* surfaced by runAgent, not thrown to startup */
    }
  });
  const userTurn: UserTurnDeps = {
    runAgent,
    getMessages: () => messages,
    clearCancelled: () => {
      cancelled = false;
    },
    gateState: () => ({
      enabled: kind !== "disabled",
      cancelled,
      planMode: kind === "plan-mode",
      planPending: kind === "pending-plan" || kind === "failed-plan",
    }),
    decision: vi.fn(),
    drainQueue: coordinatedDrain,
    review: async () =>
      driveAutopilotCycle({
        maxRounds: 2,
        isCancelled: () => cancelled,
        isPlanMode: () => kind === "plan-mode",
        planPending: () => kind === "pending-plan",
        resetReviewer,
        review,
        reviewPlan: review,
        markPlanReady: async () => ({ checkpointId: "plan", generation: 1 }),
        requestPlanRevision: async () => false,
        runPrompt: async () => {
          throw new Error("unexpected injection");
        },
        onInjected: vi.fn(),
        emit: vi.fn(),
      }),
  };
  const renderer = new AppSidecarContinuationHandoffService({
    createSynthesisSession: () => {
      throw new Error("deterministic fallback; no provider");
    },
  });
  const reset = vi.fn(async () => {
    identity = { conversationId: "destination", sessionId: "destination-file", leafId: null };
    messages.splice(0);
  });
  const prompt = vi.fn(async (text: string, onAccepted: () => Promise<void>) => {
    messages.push({ role: "user", content: text });
    identity.leafId = "accepted-user";
    await onAccepted();
    await build.promise;
    if (kind === "plain-answer") messages.push({ role: "assistant", content: "Answer only." });
    else if (kind !== "registry")
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: "Implemented and checked." },
          {
            type: "tool_call",
            id: "tool-1",
            name:
              kind === "mechanical"
                ? "read"
                : kind === "background" || kind === "git"
                  ? "bash"
                  : "edit",
            args:
              kind === "background"
                ? { command: "pnpm dev", run_in_background: true }
                : kind === "git"
                  ? { command: "git commit -m fixture" }
                  : { file_path: "fixture.ts" },
          },
        ],
      });
    if (kind === "cancelled") cancelled = true;
    if (kind === "build-failure" || kind === "failed-plan")
      throw new Error("provider failed AFTER output");
  });
  const adapter = vi.fn(
    createContinuationPromptAdapter({
      prompt,
      userTurn,
      workflowCommand: async (text) =>
        isWorkflowCommandText(text, [{ name: "compare", prompt: "compare template" }]),
    }),
  );
  const service = new AppSidecarContinuationSession({
    session,
    mutations,
    runClaim,
    busy: () => false,
    reset,
    prepare: async (text) => {
      const result = await renderer.prepare({ getState: state, getMessages: () => messages }, text);
      // Exercise the command guard at the boundary even though normal envelopes aren't commands.
      return kind === "workflow" ? { ...result, prompt: "/compare" } : result;
    },
    prompt: adapter,
    accepted: () => {
      events.push("accepted");
    },
  });
  return {
    service,
    build,
    reviewer,
    queue,
    events,
    runClaim,
    mutations,
    review,
    resetReviewer,
    reset,
    prompt,
    drainQueue,
    coordinatedDrain,
    adapter,
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("production continuation reviewer context persistence (B)", () => {
  it("pins historical task, approved plan and exact accepted instruction independently of review startup", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "continuation-review-home-"));
    const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "continuation-review-project-"));
    const restoreHome = useFakeHome(tmpHome);
    // Match the installed-tool real AgentSession fixture: no provider network,
    // no MCP/project extensions, no dispose()/global process cleanup.
    const sourceModelRegistry = new URL("../../gg-core/src/model-registry.ts", import.meta.url)
      .href;
    vi.doMock("./core/model-registry.js", async () => {
      const [local, source] = await Promise.all([
        vi.importActual<typeof ModelRegistryModule>("./core/model-registry.js"),
        import(sourceModelRegistry),
      ]);
      return { ...local, ...source };
    });
    let generation: Promise<void> | undefined;
    try {
      await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
      await fs.writeFile(
        path.join(tmpHome, ".gg", "auth.json"),
        JSON.stringify({
          openai: {
            accessToken: ["test", "token"].join("-"),
            refreshToken: ["test", "refresh"].join("-"),
            expiresAt: Date.now() + 3_600_000,
            accountId: "chatgpt-account",
          },
        }),
      );
      await fs.writeFile(
        path.join(tmpHome, ".gg", "settings.json"),
        JSON.stringify({ autoCompact: false }),
      );
      realSessionAgentLoop.mockImplementation(async function* (messages: Message[]) {
        messages.push({
          role: "assistant",
          content: `Verified source status ${messages.length}: ${"bounded implementation evidence ".repeat(20)}`,
        });
        yield { type: "agent_done" };
      });
      const { AgentSession: RealAgentSession } = await import("./core/agent-session.js");
      const options = {
        provider: "openai" as const,
        model: "gpt-6-astra",
        cwd: tmpProject,
        systemPrompt: "Deterministic test system prompt",
        mcpEnabled: false,
        projectCustomization: false,
        selfCorrectionHooks: false,
      };
      const session = new RealAgentSession(options);
      await session.initialize();
      const sourceTask =
        "Historical human task: implement the offline orchard inventory reconciliation, preserving audit records.\n" +
        "Keep the original audit identifiers stable across offline inventory reconciliation. ".repeat(
          25,
        ) +
        "\nHISTORICAL-TASK-TAIL-Ω: never merge different orchards.";
      await session.prompt(sourceTask);
      for (let index = 0; index < 6; index++) {
        await session.prompt(
          `Constraint ${index}: ${"Keep existing inventory identifiers and audit evidence intact. ".repeat(12)}`,
        );
      }
      const approvedPlan =
        "# Historical approved orchard plan\n\n1. Preserve audit identifiers.\n2. Reconcile offline stock without duplicate writes.\n\nPLAN-EVIDENCE-ONLY-Ω";
      const planHash = approvedPlanContentHash(approvedPlan);
      await session.persistApprovedPlanConsumption({
        checkpointId: "orchard-approved-checkpoint",
        generation: 7,
        content: approvedPlan,
        contentHash: planHash,
        approvedPlanPath: ".gg/plans/approved/orchard.md",
      });
      expect(session.getApprovedPlanConsumption()).toMatchObject({
        content: approvedPlan,
        contentHash: planHash,
      });
      const sourceRows = (await fs.readFile(session.getState().sessionPath, "utf8"))
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      expect(
        sourceRows.some(
          (row) =>
            row.kind === "approved_plan_consumption" &&
            row.data?.content === approvedPlan &&
            row.data?.contentHash === planHash,
        ),
      ).toBe(true);
      const source = session.getConversationIdentity();
      const prefix =
        "  Selected Ω instruction: literal \\n versus real\nnewline; ```matching``` — ";
      const suffix = "\nfinish only the selected reconciliation.  ";
      const instruction = prefix + "x".repeat(8000 - prefix.length - suffix.length) + suffix;
      expect(instruction).toHaveLength(8000);
      const handoff = new AppSidecarContinuationHandoffService({
        createSynthesisSession: () => {
          throw new Error("deterministic fallback; no synthesis provider");
        },
      });
      const automaticReview = vi.fn(async () => "all-clear" as const);
      const accepted = vi.fn();
      const runClaim = new RunClaim();
      const adapter = createContinuationPromptAdapter({
        prompt: (text, onAccepted) => session.prompt(text, undefined, { onAccepted }),
        workflowCommand: async () => false,
        userTurn: {
          runAgent: async (_text, run) => {
            await run();
          },
          getMessages: () => session.getMessages(),
          clearCancelled: () => {},
          gateState: () => ({
            enabled: false,
            cancelled: false,
            planMode: false,
            planPending: false,
          }),
          review: automaticReview,
          drainQueue: async () => {},
          decision: () => {},
        },
      });
      const service = new AppSidecarContinuationSession({
        session,
        mutations: new AppSidecarSessionMutationCoordinator(),
        runClaim,
        busy: () => false,
        prepare: (text) => handoff.prepare(session, text),
        reset: () => session.newSession(false),
        accepted,
        prompt: (text, onAccepted) => {
          generation = adapter(text, onAccepted);
          return generation;
        },
      });
      const prepared = await service.prepare(instruction);
      expect(prepared.prompt.endsWith(instruction)).toBe(true);
      expect(prepared.prompt.indexOf(instruction)).toBeGreaterThan(1500);
      expect(prepared.prompt.indexOf(instruction)).toBeGreaterThan(4000);
      const receipt = await service.commit({
        preparedId: prepared.preparedId,
        operationId: "context-b-red",
      });
      await generation;
      expect(receipt.body.outcome).toBe("accepted");
      expect(accepted).toHaveBeenCalledOnce();
      expect(automaticReview).not.toHaveBeenCalled();
      expect(session.getConversationIdentity().conversationId).not.toBe(source.conversationId);
      expect(session.getApprovedPlanConsumption()).toBeUndefined();
      const rows = (await fs.readFile(session.getState().sessionPath, "utf8"))
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      expect(
        rows.filter((row) => row.message?.role === "user").map((row) => row.message.content),
      ).toEqual([prepared.prompt]);
      expect(
        rows.some(
          (row) => row.id === (receipt.body as { acceptedMessageId?: string }).acceptedMessageId,
        ),
      ).toBe(true);

      // Explicitly invoke the same composition used by runAutopilotReview and
      // capture its real reviewer AgentSession provider boundary, not startup.
      const reviewer = new RealAgentSession(options);
      await reviewer.initialize();
      const providerInputs: string[] = [];
      realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
        const request = messages.filter((message) => message.role === "user").at(-1);
        if (request && typeof request.content === "string") providerInputs.push(request.content);
        messages.push({ role: "assistant", content: "ALL_CLEAR" });
        yield { type: "agent_done" };
      });
      await reviewer.prompt(
        buildKenAutopilotSessionContext(session, {
          cwd: tmpProject,
          gitBranch: null,
          originalRequest: prepared.prompt,
          injectedPrompts: [],
          workflowCommands: [],
        }),
      );
      expect(providerInputs).toHaveLength(1);
      const input = providerInputs[0];
      expect
        .soft(
          input.includes(sourceTask),
          "historical task content must survive, not just its summarized envelope objective",
        )
        .toBe(true);
      expect
        .soft(
          input.includes(approvedPlan),
          "durable historical approved-plan content must reach reviewer provider input",
        )
        .toBe(true);
      expect
        .soft(
          input.includes(instruction),
          "exact instruction content must survive independently of both envelope caps",
        )
        .toBe(true);
      const sections = input.split(/(?=^## )/m);
      expect
        .soft(
          sections.some(
            (section) =>
              /historical.*task/i.test(section.split("\n")[0]) && section.includes(sourceTask),
          ),
          "reviewer provider input must pin separately identified historical source task",
        )
        .toBe(true);
      expect
        .soft(
          sections.some(
            (section) =>
              /historical.*plan/i.test(section.split("\n")[0]) &&
              section.includes(approvedPlan) &&
              section.includes(planHash),
          ),
          "reviewer provider input must pin historical approved-plan content and durable hash",
        )
        .toBe(true);
      expect
        .soft(
          sections.some(
            (section) =>
              /accepted.*continuation/i.test(section.split("\n")[0]) &&
              section.includes(instruction),
          ),
          "reviewer provider input must independently pin exact accepted 8000-character instruction including whitespace and Unicode",
        )
        .toBe(true);
    } finally {
      try {
        await generation;
      } finally {
        realSessionAgentLoop.mockReset();
        vi.doUnmock("./core/model-registry.js");
        restoreHome();
        await Promise.all([
          fs.rm(tmpHome, { recursive: true, force: true }),
          fs.rm(tmpProject, { recursive: true, force: true }),
        ]);
      }
    }
  });
});

async function withReviewerStore(
  run: (create: (sessionPath?: string) => Promise<AgentSession>, cwd: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-store-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd, { recursive: true });
  const restoreHome = useFakeHome(home);
  const sourceModelRegistry = new URL("../../gg-core/src/model-registry.ts", import.meta.url).href;
  vi.doMock("./core/model-registry.js", async () => ({
    ...(await vi.importActual<typeof ModelRegistryModule>("./core/model-registry.js")),
    ...(await import(sourceModelRegistry)),
  }));
  try {
    await fs.mkdir(path.join(home, ".gg"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".gg", "auth.json"),
      JSON.stringify({
        openai: {
          accessToken: ["test", "token"].join("-"),
          refreshToken: ["test", "refresh"].join("-"),
          expiresAt: Date.now() + 3_600_000,
          accountId: "chatgpt-account",
        },
      }),
    );
    await fs.writeFile(
      path.join(home, ".gg", "settings.json"),
      JSON.stringify({ autoCompact: false }),
    );
    realSessionAgentLoop.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "done" });
      yield { type: "agent_done" };
    });
    const { AgentSession: RealAgentSession } = await import("./core/agent-session.js");
    await run(async (sessionId) => {
      const session = new RealAgentSession({
        provider: "openai",
        model: "gpt-6-astra",
        cwd,
        sessionId,
        systemPrompt: "deterministic test",
        mcpEnabled: false,
        projectCustomization: false,
        selfCorrectionHooks: false,
      });
      await session.initialize();
      return session;
    }, cwd);
  } finally {
    realSessionAgentLoop.mockReset();
    vi.doUnmock("./core/model-registry.js");
    restoreHome();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function realContinuation(session: AgentSession) {
  const handoff = new AppSidecarContinuationHandoffService({
    createSynthesisSession: () => {
      throw new Error("offline fallback");
    },
  });
  const accepted = vi.fn();
  const prompt = vi.fn((text: string, onAccepted: () => Promise<void>) =>
    session.prompt(text, undefined, { onAccepted }),
  );
  const service = new AppSidecarContinuationSession({
    session,
    runClaim: new RunClaim(),
    mutations: new AppSidecarSessionMutationCoordinator(),
    busy: () => false,
    prepare: (text) => handoff.prepare(session, text),
    reset: () => session.newSession(false),
    prompt,
    accepted,
  });
  return { service, prompt, accepted };
}

describe("continuation reviewer durable storage contracts", () => {
  it.each([
    {
      boundary: "below",
      taskChars: 3999,
      planChars: 11999,
      instructionChars: 7999,
      truncated: false,
    },
    { boundary: "at", taskChars: 4000, planChars: 12000, instructionChars: 8000, truncated: false },
    {
      boundary: "above",
      taskChars: 4000,
      planChars: 12000,
      instructionChars: 8000,
      truncated: true,
    },
  ])(
    "preserves bounded evidence $boundary truncation boundaries through both production reviewer contexts",
    async ({ taskChars, planChars, instructionChars, truncated }) => {
      await withReviewerStore(async (create, cwd) => {
        // Amendment B: task 4,000; plan 12,000; exact instruction 8,000 characters.
        // Build expected excerpts independently, with a distinct one-character overflow.
        const task = "Historical task Ω\n".padEnd(taskChars - 1, "t") + "T";
        const plan = "# Historical approved plan Ω\n".padEnd(planChars - 1, "p") + "P";
        const sourceTask = task + (truncated ? "界" : "");
        const sourcePlan = plan + (truncated ? "外" : "");
        const instruction =
          "  Exact accepted Ω\n```literal```\\n".padEnd(instructionChars - 3, "i") + "\n  ";
        expect(instruction).toHaveLength(instructionChars);
        const session = await create();
        realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
          messages.push({
            role: "assistant",
            content: "Verified source status: " + "Preserved audit identifiers. ".repeat(20),
          });
          yield { type: "agent_done" };
        });
        await session.prompt(sourceTask);
        for (let index = 0; index < 6; index++) {
          await session.prompt(
            `Constraint ${index}: ${"Preserve existing audit identifiers and reconciliation evidence. ".repeat(12)}`,
          );
        }
        const hash = approvedPlanContentHash(sourcePlan);
        await session.persistApprovedPlanConsumption({
          checkpointId: "boundary-plan",
          generation: 9,
          content: sourcePlan,
          contentHash: hash,
        });
        const origin = session.getConversationIdentity();
        const f = realContinuation(session);
        const prepared = await f.service.prepare(instruction);
        expect(prepared.prompt.indexOf(instruction)).toBeGreaterThan(4000);
        expect(prepared.prompt.endsWith(instruction)).toBe(true);
        const receipt = await f.service.commit({
          preparedId: prepared.preparedId,
          operationId: "boundary-review",
        });
        expect(receipt.body.outcome).toBe("accepted");
        await f.prompt.mock.results[0].value;
        const restored = await create(session.getState().sessionPath);
        const evidenceOrigin = {
          conversationId: origin.conversationId,
          sessionId: origin.sessionId,
        };
        expect(restored.getContinuationReviewRecord()).toMatchObject({
          source: origin,
          task: { content: task, truncated, origin: evidenceOrigin },
          plan: {
            content: plan,
            truncated,
            origin: evidenceOrigin,
            contentHash: hash,
            checkpointId: "boundary-plan",
            generation: 9,
          },
          instruction,
        });
        expect(restored.getApprovedPlanConsumption()).toBeUndefined();
        expect(restored.getState().planMode).toBe(false);
        const rows = (await fs.readFile(restored.getState().sessionPath, "utf8"))
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row));
        expect(rows.some((row) => row.kind === "approved_plan_consumption")).toBe(false);
        const reviewer = await create();
        const input = { cwd, gitBranch: null, originalRequest: prepared.prompt };
        for (const digest of [
          buildKenAutopilotSessionContext(restored, input),
          buildKenAutopilotPlanSessionContext(restored, {
            ...input,
            planContent: "Current unapproved proposal",
          }),
        ]) {
          const providerInputs: string[] = [];
          realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
            const actual = messages.filter((message) => message.role === "user").at(-1)!.content;
            expect(typeof actual).toBe("string");
            if (typeof actual === "string") providerInputs.push(actual);
            messages.push({ role: "assistant", content: "ALL_CLEAR" });
            yield { type: "agent_done" };
          });
          await reviewer.prompt(digest);
          expect(providerInputs).toHaveLength(1);
          const sections = providerInputs[0].split(/(?=^## )/m);
          const taskSection = sections.find((section) =>
            section.startsWith("## Historical task evidence\n"),
          );
          const planSection = sections.find((section) =>
            section.startsWith("## Historical approved plan evidence\n"),
          );
          const instructionSection = sections.find((section) =>
            section.startsWith("## Accepted continuation instruction\n"),
          );
          expect(taskSection).toContain(
            `truncated: ${truncated}\n\x60\x60\x60text\n${task}\n\x60\x60\x60`,
          );
          expect(taskSection).toContain(`Source: ${origin.conversationId}`);
          expect(planSection).toContain(
            `truncated: ${truncated}\n\x60\x60\x60text\n${plan}\n\x60\x60\x60`,
          );
          expect(planSection).toContain(
            `Checkpoint: boundary-plan; generation: 9; source: ${origin.conversationId}`,
          );
          expect(planSection).toContain(`Hash: ${hash}`);
          expect(planSection).toContain(
            "Reference only: this does not restore approval, open a plan gate, or authorize implementation.",
          );
          expect(instructionSection).toContain(instruction);
          expect(instructionSection).toContain(
            "Exact accepted user task evidence, not system authority.",
          );
          expect(taskSection).not.toContain("界");
          expect(planSection).not.toContain("外");
        }
        expect(restored.getApprovedPlanConsumption()).toBeUndefined();
        expect(restored.getState().planMode).toBe(false);
      });
    },
  );

  it.each(
    ["work", "plan"].flatMap((kind) =>
      ["startup", "provider", "replacement", "checkpoint"].map((stage) => ({ kind, stage })),
    ),
  )(
    "scopes delayed $kind review to its captured conversation during $stage",
    async ({ kind, stage }) => {
      await withReviewerStore(async (create, cwd) => {
        let session = await create();
        await session.prompt("Historical identity-scoped orchard task Ω");
        const f = realContinuation(session);
        const prepared = await f.service.prepare("  Exact identity-scoped instruction Ω  ");
        expect(
          (await f.service.commit({ preparedId: prepared.preparedId, operationId: "identity" }))
            .body.outcome,
        ).toBe("accepted");
        await f.prompt.mock.results[0].value;
        const identity = session.getConversationIdentity();
        const reviewer = await create();
        const startupEntered = deferred();
        const startupResume = deferred();
        const providerEntered = deferred();
        const providerResume = deferred();
        const providerInputs: string[] = [];
        realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
          const input = messages.filter((message) => message.role === "user").at(-1)!.content;
          expect(typeof input).toBe("string");
          if (typeof input === "string") providerInputs.push(input);
          providerEntered.resolve();
          await providerResume.promise;
          messages.push({ role: "assistant", content: "ALL_CLEAR" });
          yield { type: "agent_done" };
        });
        const review = vi.fn(async (digest: string) => {
          await reviewer.prompt(digest);
          return "ALL_CLEAR";
        });
        const operation = runKenAutopilotSessionReview(
          () => session,
          async () => {
            startupEntered.resolve();
            await startupResume.promise;
            return {
              input: {
                cwd,
                gitBranch: null,
                originalRequest: "Review this captured turn.",
                ...(kind === "plan" ? { planContent: "Current pending plan" } : {}),
              },
              review,
            };
          },
          () => true,
        );
        try {
          await startupEntered.promise;
          if (stage === "provider") {
            startupResume.resolve();
            await providerEntered.promise;
          }
          if (stage === "replacement") session = await create();
          else await session.newSession(stage === "checkpoint");
          expect(session.getConversationIdentity().sessionId).not.toBe(identity.sessionId);
          if (stage === "checkpoint") {
            expect(session.getConversationIdentity().conversationId).toBe(identity.conversationId);
          } else {
            expect(session.getConversationIdentity().conversationId).not.toBe(
              identity.conversationId,
            );
            expect(session.getContinuationReviewRecord()).toBeUndefined();
          }
          startupResume.resolve();
          providerResume.resolve();
          expect(await operation).toBe(stage === "checkpoint" ? "ALL_CLEAR" : null);
          if (stage === "startup" || stage === "replacement") {
            expect(review).not.toHaveBeenCalled();
            expect(providerInputs).toEqual([]);
          } else {
            expect(review).toHaveBeenCalledOnce();
            expect(providerInputs).toHaveLength(1);
            expect(providerInputs[0]).toContain("Historical identity-scoped orchard task Ω");
            expect(providerInputs[0]).toContain("  Exact identity-scoped instruction Ω  ");
            if (kind === "plan") expect(providerInputs[0]).toContain("Current pending plan");
          }
        } finally {
          startupResume.resolve();
          providerResume.resolve();
          await operation;
        }
      });
    },
  );

  it("retains exact reviewer evidence after production compaction and reload without approval authority", async () => {
    await withReviewerStore(async (create, cwd) => {
      const session = await create();
      const task = "Historical compaction task: preserve orchard audit identifiers Ω.";
      const plan =
        "# Historical approved orchard plan\nPreserve audit identifiers; reference evidence only Ω.";
      const instruction = "  Exact accepted instruction Ω\n" + "x".repeat(7900) + "\n  ";
      await session.prompt(task);
      await session.persistApprovedPlanConsumption({
        checkpointId: "compact-reference",
        generation: 3,
        content: plan,
        contentHash: approvedPlanContentHash(plan),
      });
      const f = realContinuation(session);
      const prepared = await f.service.prepare(instruction);
      expect(
        (
          await f.service.commit({
            preparedId: prepared.preparedId,
            operationId: "compact-reference",
          })
        ).body.outcome,
      ).toBe("accepted");
      await f.prompt.mock.results[0].value;
      const record = session.getContinuationReviewRecord();
      expect(record).toBeDefined();
      for (let index = 0; index < 24; index++)
        await session.prompt(`Later maintenance ${index}: ${"z".repeat(2000)}`);
      const before = session.getState().sessionPath;
      const beforeCount = session.getMessages().length;
      const summary = "Recent maintenance completed. No task or plan quoted in this summary.";
      summaryProvider.mockReturnValueOnce({
        response: Promise.resolve({
          message: { role: "assistant", content: summary },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 20 },
        }),
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      });
      try {
        await session.compact();
        expect(session.getMessages().length).toBeLessThan(beforeCount);
        expect(summaryProvider).toHaveBeenCalledOnce();
        expect(session.getState().sessionPath).not.toBe(before);
        expect(JSON.stringify(session.getMessages())).not.toContain(instruction);
        expect(
          session
            .getMessages()
            .some(
              (message) => typeof message.content === "string" && message.content.includes(summary),
            ),
        ).toBe(true);
        const restored = await create(session.getState().sessionPath);
        expect(restored.getContinuationReviewRecord()).toEqual(record);
        expect(restored.getApprovedPlanConsumption()).toBeUndefined();
        expect(restored.getState().planMode).toBe(false);
        expect(
          JSON.stringify(restored.getMessages().filter((message) => message.role === "system")),
        ).not.toContain(plan);
        const rows = (await fs.readFile(restored.getState().sessionPath, "utf8"))
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row));
        expect(
          rows.some(
            (row) => row.kind === "app_transcript_marker" && row.data?.data?.continuationReview,
          ),
        ).toBe(true);
        expect(rows.some((row) => row.kind === "approved_plan_consumption")).toBe(false);
        const reviewer = await create();
        const input = { cwd, gitBranch: null, originalRequest: "Review current maintenance only." };
        for (const digest of [
          buildKenAutopilotSessionContext(restored, input),
          buildKenAutopilotPlanSessionContext(restored, {
            ...input,
            planContent: "New unapproved proposal",
          }),
        ]) {
          realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
            const actual = messages.filter((message) => message.role === "user").at(-1)!.content;
            expect(actual).toContain(task);
            expect(actual).toContain(plan);
            expect(actual).toContain(approvedPlanContentHash(plan));
            expect(actual).toContain(instruction);
            expect(actual).toContain(
              "Reference only: this does not restore approval, open a plan gate, or authorize implementation.",
            );
            messages.push({ role: "assistant", content: "ALL_CLEAR" });
            yield { type: "agent_done" };
          });
          await reviewer.prompt(digest);
        }
      } finally {
        summaryProvider.mockReset();
      }
    });
  });

  it("retains reviewer reference evidence across a same-conversation checkpoint and reload", async () => {
    await withReviewerStore(async (create, cwd) => {
      const session = await create();
      await session.prompt("Historical checkpoint task Ω");
      const f = realContinuation(session);
      const prepared = await f.service.prepare("  checkpoint instruction Ω  ");
      expect(
        (await f.service.commit({ preparedId: prepared.preparedId, operationId: "checkpoint" }))
          .body.outcome,
      ).toBe("accepted");
      await f.prompt.mock.results[0].value;
      const record = session.getContinuationReviewRecord();
      expect(record).toBeDefined();
      await session.newSession(true);
      expect(session.getContinuationReviewRecord()).toEqual(record);
      const restored = await create(session.getState().sessionPath);
      expect(restored.getContinuationReviewRecord()).toEqual(record);
      expect(restored.getApprovedPlanConsumption()).toBeUndefined();
      expect(buildKenAutopilotSessionContext(restored, { cwd, gitBranch: null })).toContain(
        "  checkpoint instruction Ω  ",
      );
    });
  });

  it("reloads destination after rolling history, preserves chain provenance and isolates unrelated sessions", async () => {
    await withReviewerStore(async (create, cwd) => {
      const source = await create();
      const task = "  Original human orchard task Ω  ";
      const plan = "# Original approved historical plan Ω";
      const instruction = "  Exact instruction Ω\n" + "x".repeat(7900) + "  ";
      await source.prompt(task);
      await source.persistApprovedPlanConsumption({
        checkpointId: "historical",
        generation: 1,
        content: plan,
        contentHash: approvedPlanContentHash(plan),
      });
      const f = realContinuation(source);
      const prepared = await f.service.prepare(instruction);
      expect(source.getContinuationReviewRecord()).toBeUndefined();
      const result = await f.service.commit({
        preparedId: prepared.preparedId,
        operationId: "reload",
      });
      await f.prompt.mock.results[0].value;
      expect(result.body.outcome).toBe("accepted");
      const saved = source.getContinuationReviewRecord()!;
      expect(saved.instruction).toBe(instruction);
      for (let index = 0; index < 12; index++) await source.prompt(`Later unrelated turn ${index}`);
      const restored = await create(source.getState().sessionPath);
      expect(restored.getContinuationReviewRecord()).toEqual(saved);
      expect(restored.getApprovedPlanConsumption()).toBeUndefined();
      const reviewer = await create();
      const input = { cwd, gitBranch: null, originalRequest: "current turn, not historical task" };
      for (const digest of [
        buildKenAutopilotSessionContext(restored, input),
        buildKenAutopilotPlanSessionContext(restored, {
          ...input,
          planContent: "new pending plan",
        }),
      ]) {
        realSessionAgentLoop.mockImplementationOnce(async function* (messages: Message[]) {
          const actual = messages.filter((message) => message.role === "user").at(-1)!.content;
          expect(actual).toContain(task);
          expect(actual).toContain(plan);
          expect(actual).toContain(instruction);
          expect(actual).toContain(input.originalRequest);
          messages.push({ role: "assistant", content: "ALL_CLEAR" });
          yield { type: "agent_done" };
        });
        await reviewer.prompt(digest);
      }
      const newerPlan = "# New source approval replaces historical plan reference";
      await restored.persistApprovedPlanConsumption({
        checkpointId: "newer",
        generation: 2,
        content: newerPlan,
        contentHash: approvedPlanContentHash(newerPlan),
      });
      const chained = realContinuation(restored);
      const next = await chained.service.prepare("  next exact instruction Ω  ");
      expect(
        (await chained.service.commit({ preparedId: next.preparedId, operationId: "chain" })).body
          .outcome,
      ).toBe("accepted");
      await chained.prompt.mock.results[0].value;
      expect(restored.getContinuationReviewRecord()?.task).toEqual(saved.task);
      expect(restored.getContinuationReviewRecord()?.plan?.content).toBe(newerPlan);
      expect(restored.getContinuationReviewRecord()?.instruction).toBe(
        "  next exact instruction Ω  ",
      );
      await restored.newSession(false);
      expect(restored.getContinuationReviewRecord()).toBeUndefined();
      expect(buildKenAutopilotSessionContext(restored, input)).not.toContain(task);
      expect(
        (await create(restored.getState().sessionPath)).getContinuationReviewRecord(),
      ).toBeUndefined();
    });
  });

  it("fails required marker append after the first message without provider, accepted event or resend", async () => {
    await withReviewerStore(async (create) => {
      const source = await create();
      await source.prompt("source human task");
      const f = realContinuation(source);
      const prepared = await f.service.prepare("exact instruction");
      const persistence = vi
        .spyOn(source, "persistRequiredAppMarker")
        .mockRejectedValueOnce(new Error("required reviewer marker disk failure"));
      realSessionAgentLoop.mockClear();
      try {
        const request = { preparedId: prepared.preparedId, operationId: "marker-fails" };
        const result = await f.service.commit(request);
        expect(result.body.outcome).toBe("partial");
        expect(await f.service.commit(request)).toEqual(result);
        expect(f.prompt).toHaveBeenCalledOnce();
        expect(persistence).toHaveBeenCalledOnce();
        expect(realSessionAgentLoop).not.toHaveBeenCalled();
        expect(f.accepted).not.toHaveBeenCalled();
        const rows = (await fs.readFile(source.getState().sessionPath, "utf8"))
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row));
        expect(rows.filter((row) => row.message?.role === "user")).toHaveLength(1);
        expect(
          (await create(source.getState().sessionPath)).getContinuationReviewRecord(),
        ).toBeUndefined();
      } finally {
        persistence.mockRestore();
      }
    });
  });

  it("fails closed on malformed stored records without treating their envelope as a human task", async () => {
    await withReviewerStore(async (create) => {
      const session = await create();
      await session.prompt(
        "## Current objective\nsynthesized, not exact human task\n\n## Immediate next action\nold instruction",
      );
      await session.persistRequiredAppMarker("user_hint", {
        continuationReview: { version: 99, instruction: "untrusted" },
      });
      const restored = await create(session.getState().sessionPath);
      expect(restored.getContinuationReviewRecord()).toBeUndefined();
      const f = realContinuation(restored);
      const prepared = await f.service.prepare("new instruction");
      expect(
        (await f.service.commit({ preparedId: prepared.preparedId, operationId: "malformed" })).body
          .outcome,
      ).toBe("accepted");
      await f.prompt.mock.results[0].value;
      const record = restored.getContinuationReviewRecord()!;
      expect(record.task).toBeNull();
      expect(record.plan).toBeNull();
      const current = {
        conversationId: record.destination.conversationId,
        profile: record.destination.profile,
      };
      for (const invalid of [
        { ...record, version: 2 },
        { ...record, instruction: "x".repeat(8001) },
        { ...record, task: { content: "x".repeat(4001), truncated: true, origin: record.source } },
        { ...record, destination: { ...record.destination, conversationId: "unrelated" } },
        { ...record, destination: { ...record.destination, profile: "experimental" } },
        { ...record, acceptedMessageId: "" },
        { ...record, replacementPath: "/untrusted" },
      ])
        expect(parseContinuationReviewRecord(invalid, current)).toBeUndefined();
    });
  });
});

describe("production continuation review startup", () => {
  it("retains ownership after reviewer rejection until draining finishes and preserves the review error", async () => {
    const f = fixture();
    const reviewError = new Error("reviewer model switch failed");
    f.review.mockImplementationOnce(async () => {
      await f.reviewer.promise;
      throw reviewError;
    });
    try {
      const prepared = await f.service.prepare("Finish implementation.");
      const request = { preparedId: prepared.preparedId, operationId: "review-rejection" };
      const receipt = await f.service.commit(request);
      expect(receipt.body.outcome).toBe("accepted");
      const outcome = f.adapter.mock.results[0].value.catch((error: unknown) => error);
      f.build.resolve();
      await tick();
      expect(f.review).toHaveBeenCalledOnce();
      queueMicrotask(() => {
        void f.coordinatedDrain();
      });
      f.reviewer.resolve();
      await tick();
      expect(f.drainQueue).toHaveBeenCalledOnce();
      expect(f.runClaim.active, "review rejection must still await draining").toBe(true);
      expect(await f.service.commit(request)).toEqual(receipt);
      f.queue.resolve();
      expect(await outcome).toBe(reviewError);
      await tick();
      expect(f.runClaim.active).toBe(false);
      expect(await f.service.commit(request)).toEqual(receipt);
      expect(f.prompt).toHaveBeenCalledOnce();
      expect(f.drainQueue).toHaveBeenCalledOnce();
    } finally {
      f.build.resolve();
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
    }
  });

  it("holds ownership until an already-running drain finishes", async () => {
    const f = fixture();
    try {
      const prepared = await f.service.prepare("Finish implementation.");
      const request = { preparedId: prepared.preparedId, operationId: "drain-race" };
      const receipt = await f.service.commit(request);
      expect(receipt.body.outcome).toBe("accepted");
      f.build.resolve();
      await tick();
      expect(f.review).toHaveBeenCalledOnce();
      // The cycle schedules this before the awaiting user turn resumes.
      queueMicrotask(() => {
        void f.coordinatedDrain();
      });
      f.reviewer.resolve();
      await tick();
      expect(f.drainQueue).toHaveBeenCalledOnce();
      expect(f.runClaim.active, "ownership must span the already-running drain").toBe(true);
      expect(await f.service.commit(request)).toEqual(receipt);
      f.queue.resolve();
      await tick();
      expect(f.runClaim.active).toBe(false);
      expect(f.drainQueue).toHaveBeenCalledOnce();
      expect(f.prompt).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
    } finally {
      f.build.resolve();
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
    }
  });

  it.each([
    "disabled",
    "cancelled",
    "plan-mode",
    "workflow",
    "registry",
    "mechanical",
    "plain-answer",
    "background",
    "git",
    "build-failure",
    "failed-plan",
  ])("does not review %s, drains queue and preserves accepted receipt on retry", async (kind) => {
    const f = fixture(kind);
    try {
      const prepared = await f.service.prepare("Finish implementation.");
      const request = { preparedId: prepared.preparedId, operationId: kind };
      const receipt = await f.service.commit(request);
      expect(receipt.body.outcome).toBe("accepted");
      f.build.resolve();
      await tick();
      expect(f.review).not.toHaveBeenCalled();
      expect(f.resetReviewer).not.toHaveBeenCalled();
      expect(f.drainQueue).toHaveBeenCalledOnce();
      expect(f.runClaim.active).toBe(true);
      expect(await f.service.commit(request)).toEqual(receipt);
      f.queue.resolve();
      await tick();
      expect(f.runClaim.active).toBe(false);
      expect(await f.service.commit(request)).toEqual(receipt);
      expect(f.reset).toHaveBeenCalledOnce();
      expect(f.prompt).toHaveBeenCalledOnce();
    } finally {
      f.build.resolve();
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
    }
  });

  it("does not review or resend when runAgent skips the callback", async () => {
    const f = fixture("skipped-callback");
    f.queue.resolve();
    const prepared = await f.service.prepare("Finish implementation.");
    const request = { preparedId: prepared.preparedId, operationId: "skipped" };
    const receipt = await f.service.commit(request);
    expect(receipt.body.outcome).toBe("partial");
    await tick();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.runClaim.active).toBe(false);
    expect(await f.service.commit(request)).toEqual(receipt);
    expect(f.reset).toHaveBeenCalledOnce();
  });

  it.each(["pending-plan", "review-failure"])("preserves acceptance through %s", async (kind) => {
    const f = fixture(kind);
    try {
      const prepared = await f.service.prepare("Finish implementation.");
      const request = { preparedId: prepared.preparedId, operationId: kind };
      const receipt = await f.service.commit(request);
      f.build.resolve();
      await tick();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.runClaim.active).toBe(true);
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
      expect(f.runClaim.active).toBe(false);
      expect(receipt.body.outcome).toBe("accepted");
      expect(await f.service.commit(request)).toEqual(receipt);
      expect(f.prompt).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
    } finally {
      f.build.resolve();
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
    }
  });
  it("accepts first, starts one real cycle, and retains ownership through review and queue with receipt-only retries", async () => {
    const f = fixture();
    try {
      const prepared = await f.service.prepare("Finish the scoped implementation.");
      const request = { preparedId: prepared.preparedId, operationId: "operation" };
      const receipt = await f.service.commit(request);
      expect(receipt.body.outcome).toBe("accepted");
      expect(f.events).toEqual(["accepted"]);
      expect(f.mutations.owner).toBeNull();
      expect(f.runClaim.active).toBe(true);
      expect(await f.service.commit(request)).toEqual(receipt);
      f.build.resolve();
      await tick();
      expect(f.review, "eligible continuation must start reviewer").toHaveBeenCalledOnce();
      expect(f.events).toEqual(["accepted", "review"]);
      expect(f.runClaim.active).toBe(true);
      expect(await f.service.commit(request)).toEqual(receipt);
      f.reviewer.resolve();
      await tick();
      expect(f.drainQueue).toHaveBeenCalledOnce();
      expect(f.runClaim.active).toBe(true);
      f.queue.resolve();
      await tick();
      expect(f.runClaim.active).toBe(false);
      expect(await f.service.commit(request)).toEqual(receipt);
      expect(f.reset).toHaveBeenCalledOnce();
      expect(f.prompt).toHaveBeenCalledOnce();
      expect(f.resetReviewer).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
    } finally {
      f.build.resolve();
      f.reviewer.resolve();
      f.queue.resolve();
      await tick();
    }
  });
});
