import { z } from "zod";
import { createHash } from "node:crypto";
import type { Message } from "@kenkaiiii/gg-ai";
import type { ApprovedPlanConsumptionRecord } from "./session-manager.js";

const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const profile = z.enum(["stable", "experimental"]);
const identity = z.object({ conversationId: id, sessionId: id }).strict();
const task = z.object({
  content: z.string().min(1).max(4000), truncated: z.boolean(), origin: identity,
}).strict().refine((value) => !value.truncated || value.content.length === 4000);
const plan = z.object({
  content: z.string().min(1).max(12000), truncated: z.boolean(), origin: identity,
  checkpointId: id, generation: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["approval-committed", "implementation-prompt-started", "completed"]),
  approvedPlanPath: z.string().min(1).max(2000).optional(),
}).strict().refine((value) => value.truncated ? value.content.length === 12000 :
  createHash("sha256").update(value.content, "utf8").digest("hex") === value.contentHash);

export const continuationReviewSchema = z.object({
  version: z.literal(1),
  source: identity.extend({ leafId: id.nullable(), fingerprint: z.string().min(1).max(256) }).strict(),
  sourceProfile: profile,
  destination: identity.extend({ profile }).strict(),
  preparedId: id, operationId: id, acceptedMessageId: id,
  task: task.nullable(), plan: plan.nullable(),
  instruction: z.string().min(1).max(8000).refine((text) => text.trim().length > 0),
}).strict();

export type ContinuationReviewRecord = z.infer<typeof continuationReviewSchema>;
export type ContinuationReviewEvidence = Pick<ContinuationReviewRecord, "task" | "plan">;

/** Only the destination conversation/profile is live authority. Physical session
 * and accepted message IDs are historical provenance after restore/compaction. */
export function parseContinuationReviewRecord(
  value: unknown,
  current: { conversationId: string; profile: string },
): ContinuationReviewRecord | undefined {
  const parsed = continuationReviewSchema.safeParse(value);
  if (!parsed.success || parsed.data.destination.conversationId !== current.conversationId ||
      parsed.data.destination.profile !== current.profile ||
      parsed.data.source.conversationId === parsed.data.destination.conversationId) return undefined;
  return parsed.data;
}

export function captureContinuationReviewEvidence(
  messages: Message[], origin: { conversationId: string; sessionId: string },
  approved: ApprovedPlanConsumptionRecord | undefined,
  previous: ContinuationReviewRecord | undefined,
): ContinuationReviewEvidence {
  // Never reinterpret an old generated continuation envelope as a human task.
  const human = messages.find((message) => message.role === "user" &&
    message.provenance?.visibility !== "hidden" && message.provenance?.source !== "runtime" &&
    !["automation", "notification", "compaction_summary"].includes(message.provenance?.kind ?? "") &&
    !(typeof message.content === "string" && (message.content.startsWith(COMPACTION_SUMMARY_MARKER) ||
      message.content.startsWith("## Current objective\n"))));
  const content = human ? (typeof human.content === "string" ? human.content :
    human.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")) : "";
  return {
    task: previous ? structuredClone(previous.task) : content.trim() ? { content: content.slice(0, 4000), truncated: content.length > 4000, origin: { conversationId: origin.conversationId, sessionId: origin.sessionId } } : null,
    plan: approved ? {
      content: approved.content.slice(0, 12000), truncated: approved.content.length > 12000,
      origin: { conversationId: origin.conversationId, sessionId: origin.sessionId }, checkpointId: approved.checkpointId, generation: approved.generation,
      contentHash: approved.contentHash, state: approved.state,
      ...(approved.approvedPlanPath && approved.approvedPlanPath.length <= 2000 ? { approvedPlanPath: approved.approvedPlanPath } : {}),
    } : structuredClone(previous?.plan ?? null),
  };
}
