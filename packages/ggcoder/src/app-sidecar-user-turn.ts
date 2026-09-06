import type { Message } from "@kenkaiiii/gg-ai";
import {
  countAssistantMessages, extractTurnToolCalls, isMechanicalOnlyTurn,
  shouldStartAutopilotCycle, type AutopilotGateInput,
} from "./core/autopilot-gate.js";

export interface UserTurnDeps {
  runAgent: (text: string, run: () => Promise<void>) => Promise<void>;
  getMessages: () => Message[];
  clearCancelled: () => void;
  gateState: () => Pick<AutopilotGateInput, "enabled" | "cancelled" | "planMode" | "planPending">;
  review: (text: string) => Promise<void>;
  drainQueue: () => Promise<void>;
  decision: (decision: ReturnType<typeof shouldStartAutopilotCycle>) => void;
}

/** Ordinary user-turn gate. Injected reviewer runs must stay on plain runAgent. */
export async function runUserTurn(
  deps: UserTurnDeps, text: string, run: () => Promise<void>,
  workflowCommand: boolean, onSettled?: () => void,
): Promise<void> {
  deps.clearCancelled();
  const assistantsBefore = countAssistantMessages(deps.getMessages());
  const messagesBefore = deps.getMessages().length;
  // runAgent reports/swallow errors and may skip the callback on cancellation.
  // Only completed provider work is eligible, even if a failure left tool output.
  let completed = false;
  await deps.runAgent(text, async () => {
    await run();
    completed = true;
  });
  onSettled?.();
  const decision = completed ? shouldStartAutopilotCycle({
    ...deps.gateState(), workflowCommand,
    assistantMessagesAdded: countAssistantMessages(deps.getMessages()) - assistantsBefore,
    mechanicalOnly: isMechanicalOnlyTurn(extractTurnToolCalls(deps.getMessages(), messagesBefore)),
  }) : { start: false as const, reason: "no-assistant-output" as const };
  deps.decision(decision);
  try {
    if (decision.start) await deps.review(text);
  } finally {
    await deps.drainQueue();
  }
}

/** Coordinate the cycle's scheduled drain with the user-turn ownership barrier. */
export function createStrandedQueueDrain(blocked: () => boolean, drain: () => Promise<void>) {
  let activeDrain: Promise<void> | undefined;
  return (): Promise<void> => {
    if (activeDrain) return activeDrain;
    if (blocked()) return Promise.resolve();
    // Publish ownership before executing the drain, including synchronous re-entry.
    activeDrain = Promise.resolve().then(drain).finally(() => { activeDrain = undefined; });
    return activeDrain;
  };
}

/** Production continuation composition, kept importable without daemon bootstrap. */
export function createContinuationPromptAdapter(deps: {
  prompt: (text: string, onAccepted: () => Promise<void>) => Promise<void>;
  userTurn: UserTurnDeps;
  workflowCommand: (text: string) => Promise<boolean>;
}) {
  return async (text: string, onAccepted: () => Promise<void>): Promise<void> =>
    runUserTurn(deps.userTurn, text, () => deps.prompt(text, onAccepted),
      await deps.workflowCommand(text));
}
