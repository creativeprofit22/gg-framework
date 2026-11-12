// Local Fork-owned: durable approved-plan consumption for AgentSession. Kept
// out of agent-session.ts so upstream syncs of that file stay small.
import type { Message } from "@kenkaiiii/gg-ai";
import type { ActivePhaseContextV1 } from "../phase-context.js";
import {
  approvedPlanContentHash,
  type ApprovedPlanConsumptionInput,
  type ApprovedPlanConsumptionRecord,
  type SessionManager,
} from "./session-manager.js";

/** Live AgentSession state read and written by approved-plan consumption. */
export interface SessionApprovedPlanHost {
  sessionPath(): string;
  sessionManager(): SessionManager;
  approvedPlanConsumption(): ApprovedPlanConsumptionRecord | undefined;
  setApprovedPlanConsumption(record: ApprovedPlanConsumptionRecord | undefined): void;
  setApprovedPlanPath(planPath: string | undefined): void;
  setApprovedPlanPhaseContext(context: ActivePhaseContextV1 | undefined): void;
  setApprovedPlanHydrationDeferred(deferred: boolean): void;
  activePhaseContext(): ActivePhaseContextV1 | undefined;
  messages(): Message[];
  lockContextProfile(): void;
  persistMessage(message: Message, required: boolean): Promise<void>;
  setLastPersistedIndex(index: number): void;
  persistedTranscriptCount(): number;
  rebuildSystemPromptInPlace(): Promise<void>;
  refreshSystemPromptTail(): void;
}

export async function persistApprovedPlanConsumption(
  host: SessionApprovedPlanHost,
  input: ApprovedPlanConsumptionInput,
): Promise<ApprovedPlanConsumptionRecord> {
  if (!host.sessionPath())
    throw new Error("Approved plan consumption requires a persistent session.");
  if (approvedPlanContentHash(input.content) !== input.contentHash) {
    throw new Error("Approved plan content hash does not match its captured content.");
  }
  const record: ApprovedPlanConsumptionRecord = {
    version: 1,
    ...input,
    state: "approval-committed",
  };
  await host.sessionManager().appendApprovedPlanConsumptionRequired(host.sessionPath(), record);
  host.setApprovedPlanHydrationDeferred(false);
  host.setApprovedPlanConsumption(record);
  const activePhaseContext = host.activePhaseContext();
  host.setApprovedPlanPhaseContext(
    activePhaseContext ? structuredClone(activePhaseContext) : undefined,
  );
  host.setApprovedPlanPath(record.approvedPlanPath);
  await host.rebuildSystemPromptInPlace();
  return structuredClone(record);
}

export async function hydrateCanonicalApprovedPlan(
  host: SessionApprovedPlanHost,
  input: Omit<ApprovedPlanConsumptionRecord, "version">,
): Promise<ApprovedPlanConsumptionRecord> {
  if (!host.sessionPath()) throw new Error("Cannot hydrate approved plan without a session path.");
  if (input.state === "completed") throw new Error("Cannot hydrate a completed approved plan.");
  if (approvedPlanContentHash(input.content) !== input.contentHash) {
    throw new Error("Canonical approved plan content does not match its durable hash.");
  }
  const record: ApprovedPlanConsumptionRecord = { version: 1, ...input };
  const current = host.approvedPlanConsumption();
  if (
    !current ||
    current.checkpointId !== record.checkpointId ||
    current.generation !== record.generation ||
    current.content !== record.content ||
    current.contentHash !== record.contentHash ||
    current.state !== record.state ||
    current.approvedPlanPath !== record.approvedPlanPath
  ) {
    await host.sessionManager().appendApprovedPlanConsumptionRequired(host.sessionPath(), record);
  }
  host.setApprovedPlanHydrationDeferred(false);
  host.setApprovedPlanConsumption(record);
  host.setApprovedPlanPath(record.approvedPlanPath);
  const activePhaseContext = host.activePhaseContext();
  host.setApprovedPlanPhaseContext(
    activePhaseContext ? structuredClone(activePhaseContext) : undefined,
  );
  await host.rebuildSystemPromptInPlace();
  host.refreshSystemPromptTail();
  return structuredClone(record);
}

export async function markApprovedPlanImplementationPromptStarted(
  host: SessionApprovedPlanHost,
): Promise<ApprovedPlanConsumptionRecord> {
  const current = host.approvedPlanConsumption();
  if (!current) throw new Error("No approved plan consumption is committed.");
  if (current.state === "implementation-prompt-started") return structuredClone(current);
  if (!host.sessionPath())
    throw new Error("Approved plan consumption requires a persistent session.");
  const started: ApprovedPlanConsumptionRecord = {
    ...current,
    state: "implementation-prompt-started",
  };
  await host.sessionManager().appendApprovedPlanConsumptionRequired(host.sessionPath(), started);
  host.setApprovedPlanConsumption(started);
  return structuredClone(started);
}

export async function completeApprovedPlanConsumption(
  host: SessionApprovedPlanHost,
): Promise<void> {
  const current = host.approvedPlanConsumption();
  if (!current) return;
  if (!host.sessionPath())
    throw new Error("Completing approved plan consumption requires a persistent session.");
  const completed: ApprovedPlanConsumptionRecord = {
    ...current,
    state: "completed",
  };
  await host.sessionManager().appendApprovedPlanConsumptionRequired(host.sessionPath(), completed);
  host.setApprovedPlanConsumption(undefined);
  host.setApprovedPlanPhaseContext(undefined);
  host.setApprovedPlanPath(undefined);
  await host.rebuildSystemPromptInPlace();
}

export async function runApprovedPlanImplementation(
  host: SessionApprovedPlanHost,
  prompt: string,
  generation: number,
  run: () => Promise<void>,
): Promise<void> {
  const consumption = host.approvedPlanConsumption();
  if (!consumption) throw new Error("No approved plan consumption is committed.");
  if (consumption.state === "implementation-prompt-started") return;

  const latest = host.messages().at(-1);
  const promptAlreadyPersisted = latest?.role === "user" && latest.content === prompt;
  if (!promptAlreadyPersisted) {
    const userMessage: Message = {
      role: "user",
      content: prompt,
      provenance: { source: "runtime", kind: "automation", visibility: "transcript" },
    };
    host.lockContextProfile();
    host.messages().push(userMessage);
    await host.persistMessage(userMessage, true);
    host.setLastPersistedIndex(host.messages().length);
  }
  if (!host.sessionPath())
    throw new Error("Approved plan implementation requires a persistent session.");
  await host.sessionManager().appendRunStartedRequired(host.sessionPath(), {
    version: 1,
    generation,
    startedAt: new Date().toISOString(),
    afterMessageCount: host.persistedTranscriptCount(),
  });
  await markApprovedPlanImplementationPromptStarted(host);
  await run();
}
