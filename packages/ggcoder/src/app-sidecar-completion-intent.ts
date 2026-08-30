import { checkpointSettledPhaseImplementation } from "./app-sidecar-phase-completion.js";
import type { AppSidecarCompletionIntent } from "./app-sidecar-roadmap-tool-host.js";

export type AppSidecarCompletionIntentRunToken = number;
type CompletionCheckpointInput = Omit<
  Parameters<typeof checkpointSettledPhaseImplementation>[0],
  "completionIntentId"
>;

/** Settles one captured intent at most once, independent of later provider runs. */
export class AppSidecarCompletionIntentRunFinalizer {
  constructor(private intent: AppSidecarCompletionIntent | null) {}

  checkpoint(input: CompletionCheckpointInput) {
    const intent = this.intent;
    this.intent = null;
    const completionIntentId =
      intent?.phaseId === input.phaseId &&
      intent.session.sessionId === input.expectedSession.sessionId &&
      intent.session.sessionPath === input.expectedSession.sessionPath
        ? intent.statusUpdateId
        : undefined;
    return checkpointSettledPhaseImplementation({
      ...input,
      ...(completionIntentId ? { completionIntentId } : {}),
    });
  }
}

/** Binds transient Roadmap completion intent to one provider run. */
export class AppSidecarCompletionIntentTracker {
  private nextRunToken = 0;
  private active: {
    token: AppSidecarCompletionIntentRunToken;
    intent: AppSidecarCompletionIntent | null;
  } | null = null;

  beginRun(): AppSidecarCompletionIntentRunToken {
    const token = ++this.nextRunToken;
    this.active = { token, intent: null };
    return token;
  }

  record(intent: AppSidecarCompletionIntent): void {
    if (this.active) this.active.intent = intent;
  }

  take(token: AppSidecarCompletionIntentRunToken): AppSidecarCompletionIntent | null {
    if (this.active?.token !== token) return null;
    const intent = this.active.intent;
    this.active = null;
    return intent;
  }

  finalizeRun(token: AppSidecarCompletionIntentRunToken): AppSidecarCompletionIntentRunFinalizer {
    return new AppSidecarCompletionIntentRunFinalizer(this.take(token));
  }
}
