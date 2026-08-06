import crypto from "node:crypto";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import { getHistoryMessageVisibility } from "./session-history.js";
import type { SessionManager, MessageEntry, LabelEntry } from "./session-manager.js";

/** Stable identity for one compaction source, including internal provenance. */
export function sourceFingerprint(messages: readonly Message[]): string {
  const source = messages.filter((message) => message.role !== "system");
  return crypto.createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export async function appendMessagesToSession(
  sessionManager: SessionManager,
  sessionPath: string,
  messages: readonly Message[],
  startIndex = 0,
): Promise<void> {
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    const entry: MessageEntry = {
      type: "message",
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: msg,
    };
    await sessionManager.appendEntry(sessionPath, entry);
  }
}

export async function createCompactedSessionCheckpoint(
  sessionManager: SessionManager,
  options: {
    cwd: string;
    provider: Provider;
    model: string;
    messages: readonly Message[];
    conversationId?: string;
    generation?: number;
    parentSessionId?: string;
    sourceFingerprint?: string;
    retainedMessageCount?: number;
    preview?: string;
    title?: string;
  },
): Promise<{ path: string; id: string }> {
  const session = await sessionManager.create(options.cwd, options.provider, options.model, {
    conversationId: options.conversationId,
    generation: options.generation,
    parentSessionId: options.parentSessionId,
    sourceFingerprint: options.sourceFingerprint,
    retainedMessageCount: options.retainedMessageCount,
    preview: options.preview ?? options.title,
  });
  await appendMessagesToSession(sessionManager, session.path, options.messages, 0);
  if (options.title) {
    const titleEntry: LabelEntry = {
      type: "label",
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      label: options.title,
    };
    await sessionManager.appendEntry(session.path, titleEntry);
  }
  return { path: session.path, id: session.id };
}

export function getRestoredMessagesForDisplay(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) => message.role !== "system" && getHistoryMessageVisibility(message) !== "hidden",
  );
}

export function formatRestoreInfoText(originalCount: number, restoredCount: number): string {
  if (originalCount === restoredCount) {
    return `↻ Restored session (${originalCount} messages)`;
  }
  return `↻ Restored compacted session (${originalCount} → ${restoredCount} messages)`;
}
