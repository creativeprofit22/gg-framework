import { randomUUID } from "node:crypto";
import type { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

import type { KenTarget, KenRunIdentity, KenState } from "@kenkaiiii/gg-core/desktop-session-ux";
export type { KenTarget, KenRunIdentity } from "@kenkaiiii/gg-core/desktop-session-ux";

interface BuildSession {
  getConversationIdentity(): { conversationId: string };
  persistKenTurn(text: string, reply: string): Promise<void>;
}
interface KenSession {
  prompt(text: string): Promise<unknown>;
  setSignal(signal: AbortSignal): void;
  newSession(preserveConversation: boolean): Promise<void>;
}
interface KenLifecycleDependencies<Build extends BuildSession, Ken extends KenSession, Model> {
  mutations: AppSidecarSessionMutationCoordinator;
  getBuildSession(): Build;
  ensureSession(signal: AbortSignal): Promise<Ken>;
  buildContext(build: Build, text: string): Promise<string>;
  replyText(ken: Ken): string;
  listen(ken: Ken, publish: (type: string, data: object) => boolean): () => void;
  footerExtras(): object;
  broadcast(type: string, data: unknown): void;
  reportError(error: unknown): object;
  switchModel(ken: Ken, model: Model): Promise<void>;
  clearPendingState(): void;
  currentModel(): Model;
}

export class KenLifecycleBusyError extends Error {
  readonly status = 409;
  readonly body = { error: "ken_busy", retryable: true, message: "Ken is busy or retiring; retry shortly." };
  constructor() { super("Ken is busy or retiring; retry shortly."); }
}

export class KenInitializationError extends Error {
  readonly body = {
    error: "ken_initialization_failed", retryable: false,
    message: "Ken initialization failed after allocation. This daemon session cannot safely retry initialization.",
  };
  constructor(cause: unknown) { super("Ken initialization failed after allocation", { cause }); }
}

/** Keep one allocated instance, including partial initialization failures. Only
 * failures before create() returns an instance may retry resource allocation. */
export function createKenSessionInitializer<Ken>(options: {
  create(signal: AbortSignal): Promise<Ken>;
  initialize(ken: Ken): Promise<void>;
}) {
  let instance: Ken | undefined;
  let pending: Promise<Ken> | undefined;
  return (signal: AbortSignal): Promise<Ken> => {
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        try {
          instance = await options.create(signal);
          await options.initialize(instance);
          return instance;
        } catch (error) {
          if (instance !== undefined) throw new KenInitializationError(error);
          pending = undefined;
          throw error;
        }
      });
    }
    return pending;
  };
}

export function parseKenTarget(value: unknown): KenTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("conversationId" in value) || typeof value.conversationId !== "string" || !value.conversationId.trim() ||
      !("activationEpoch" in value) || typeof value.activationEpoch !== "string" || !value.activationEpoch.trim()) return null;
  return { conversationId: value.conversationId, activationEpoch: value.activationEpoch };
}

export function parseKenPromptInput(value: unknown): { text: string; target: KenTarget } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || !("target" in value)) return null;
  const target = parseKenTarget(value.target);
  return typeof value.text === "string" && value.text.trim() && target ? { text: value.text, target } : null;
}

export function parseKenRunIdentity(value: unknown): KenRunIdentity | null {
  if (!value || typeof value !== "object") return null;
  if (!("conversationId" in value) || typeof value.conversationId !== "string" || !value.conversationId.trim() ||
      !("activationEpoch" in value) || typeof value.activationEpoch !== "string" || !value.activationEpoch.trim() ||
      !("runId" in value) || typeof value.runId !== "string" || !value.runId.trim()) return null;
  return { conversationId: value.conversationId, activationEpoch: value.activationEpoch, runId: value.runId };
}

/** One mentor per pane. Abort is advisory; captured target/run ownership is the
 * authority. Retirement never waits inside a build transition or disposes tools. */
export function createAppSidecarKenLifecycle<Build extends BuildSession, Ken extends KenSession, Model>(
  deps: KenLifecycleDependencies<Build, Ken, Model>,
) {
  type Run = {
    identity: KenRunIdentity;
    build: Build;
    abort: AbortController;
    valid: boolean;
    detach: () => void;
  };
  let target: KenTarget = {
    conversationId: deps.getBuildSession().getConversationIdentity().conversationId,
    activationEpoch: randomUUID(),
  };
  let mentor: Ken | null = null;
  let initializationFailure: KenInitializationError | null = null;
  let active: Run | null = null;
  let work: Promise<void> | null = null;
  let transitions = 0;
  let resetNeeded = false;
  let pendingModel: { epoch: string; model: Model } | null = null;

  function matches(run: Run): boolean {
    return active === run && run.valid &&
      target.activationEpoch === run.identity.activationEpoch &&
      deps.getBuildSession().getConversationIdentity().conversationId === run.identity.conversationId;
  }
  function publish(run: Run, type: string, data: object): boolean {
    if (!matches(run)) return false;
    deps.broadcast(type, { ...data, ken: run.identity });
    return true;
  }
  function state(): KenState {
    return { ...target, activeRunId: active && matches(active) ? active.identity.runId : null };
  }
  function announce(): void { deps.broadcast("extras", { kenState: state() }); }
  function invalidate(): void {
    target = { ...target, activationEpoch: randomUUID() };
    pendingModel = null;
    deps.clearPendingState();
    resetNeeded = true;
    if (active) {
      active.valid = false;
      active.detach();
      active.abort.abort();
    }
    announce();
    if (!work) launchMaintenance();
  }
  function rebind(): void {
    const conversationId = deps.getBuildSession().getConversationIdentity().conversationId;
    if (conversationId !== target.conversationId) {
      invalidate();
      target = { ...target, conversationId };
      announce();
    }
  }
  async function maintenance(): Promise<void> {
    // Invalidations may arrive while reset/model switch awaits. Always drain the
    // current generation before making the single mentor available again.
    while (resetNeeded || pendingModel) {
      if (resetNeeded) {
        resetNeeded = false;
        if (mentor) {
          try {
            mentor.setSignal(new AbortController().signal);
            await mentor.newSession(false);
          }
          catch (error) {
            resetNeeded = true; // Fail closed; a later attempt can retry reset.
            deps.reportError(error);
            return;
          }
        }
      } else {
        const pending = pendingModel!;
        pendingModel = null;
        if (mentor && pending.epoch === target.activationEpoch) {
          try { await deps.switchModel(mentor, pending.model); }
          catch (error) { deps.reportError(error); }
        }
      }
    }
  }
  function track(operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => { if (work === tracked) work = null; });
    work = tracked;
    return tracked;
  }
  function launchMaintenance(): void {
    // Defer execution until work has its owner, including synchronous callbacks.
    track(Promise.resolve().then(maintenance));
  }
  async function execute(run: Run, text: string): Promise<void> {
    let providerCompleted = false;
    try {
      if (!matches(run)) return;
      mentor = await deps.ensureSession(run.abort.signal);
      if (!matches(run)) return;
      mentor.setSignal(run.abort.signal);
      await deps.switchModel(mentor, deps.currentModel());
      if (!matches(run)) return;
      const digest = await deps.buildContext(run.build, text);
      if (!matches(run)) return;
      run.detach = deps.listen(mentor, (type, data) => publish(run, type, data));
      await mentor.prompt(digest);
      providerCompleted = true;
      if (!matches(run)) return;
      const reply = deps.replyText(mentor);
      if (reply.trim()) {
        const append = deps.mutations.tryAcquire("ken-append");
        if (!append) throw new KenLifecycleBusyError();
        try {
          if (!matches(run)) return;
          // A checkpoint/compaction can move the physical destination. Only the
          // currently verified build object may receive the advisory append.
          const destination = deps.getBuildSession();
          if (destination.getConversationIdentity().conversationId !== run.identity.conversationId) return;
          await destination.persistKenTurn(text, reply);
          publish(run, "extras", deps.footerExtras());
        } finally { append.release(); }
      }
    } catch (error) {
      if (error instanceof KenInitializationError) initializationFailure = error;
      if (matches(run)) {
        publish(run, "ken_error", {
          ...deps.reportError(error),
          ...(error instanceof KenInitializationError ? error.body : { retryable: error instanceof KenLifecycleBusyError }),
        });
      }
      // A completed same-conversation answer rejected only by the append lease
      // is still valid mentor memory. Partial/failed provider context is not.
      if (!providerCompleted) resetNeeded = true;
    } finally {
      run.detach();
      if (matches(run)) {
        publish(run, "ken_run_end", {});
        run.valid = false;
        announce();
      } else resetNeeded = true;
      // Keep the slot owned through queued model switches and retirement.
      await maintenance();
      if (active === run) active = null;
    }
  }

  return {
    get running() { return active !== null || work !== null; },
    get target(): KenTarget { rebind(); return { ...target }; },
    get state(): KenState { rebind(); return state(); },
    get settled(): Promise<void> { return work ?? Promise.resolve(); },
    prompt(text: string, requestedTarget: KenTarget): { status: 202; completion: Promise<void>; identity: KenRunIdentity }
      | { status: 400 | 409; body: { error: string; retryable: boolean; message: string } }
      | { status: 503; body: KenInitializationError["body"] } {
      // Validate again for direct callers. Never substitute the current target.
      const requested = parseKenTarget(requestedTarget);
      if (!requested || typeof text !== "string" || !text.trim()) return {
        status: 400, body: { error: "invalid_ken_prompt", retryable: false,
          message: "Non-empty text and target conversationId and activationEpoch are required." },
      };
      const startup = deps.mutations.tryAcquire("ken-start");
      if (!startup) return { status: 409, body: new KenLifecycleBusyError().body };
      try {
        // Target comparison and run allocation share the synchronous startup
        // lease: transport delay must never retarget a captured request.
        rebind();
        if (requested.conversationId !== target.conversationId || requested.activationEpoch !== target.activationEpoch) return {
          status: 409, body: { error: "ken_target_stale", retryable: false,
            message: "Ken target changed; submit a new request for the current conversation." },
        };
        if (initializationFailure) return { status: 503, body: initializationFailure.body };
        if (work || active || transitions || resetNeeded || !target.conversationId) {
          if (resetNeeded && !work) launchMaintenance();
          return { status: 409, body: new KenLifecycleBusyError().body };
        }
        const run: Run = {
          identity: { ...target, runId: randomUUID() },
          build: deps.getBuildSession(), abort: new AbortController(), valid: true, detach: () => {},
        };
        active = run;
        // Startup only owns synchronous acceptance/capture, never initialization
        // or provider work. Reset can invalidate even deferred initialization.
        const completion = track(Promise.resolve().then(() => execute(run, text)));
        announce(); // Authority must reach clients before any run event.
        publish(run, "ken_run_start", { text });
        return { status: 202, completion, identity: run.identity };
      } finally { startup.release(); }
    },
    cancel(identity?: KenRunIdentity): boolean {
      if (!active || (identity && (identity.runId !== active.identity.runId ||
        identity.activationEpoch !== active.identity.activationEpoch ||
        identity.conversationId !== active.identity.conversationId))) return false;
      publish(active, "ken_run_end", { cancelled: true });
      active.valid = false;
      announce();
      active.detach();
      active.abort.abort();
      pendingModel = null;
      deps.clearPendingState();
      resetNeeded = true;
      return true;
    },
    abort(): void { this.cancel(); },
    syncModel(model: Model): Promise<void> {
      pendingModel = { epoch: target.activationEpoch, model };
      if (active) return Promise.resolve(); // Queue, do not hold the model route on provider work.
      if (!work) launchMaintenance();
      return work!;
    },
    /** Call synchronously before the transition's first await, and finish in
     * finally even on failure. Retain only a verified same-conversation checkpoint.
     * A phase route takes its own lease immediately after entering this scope. */
    beginTransition(retain = false, routeAcquiresLease = false): () => void {
      const owner = deps.mutations.owner;
      if (owner?.kind === "ken-append" || owner?.kind === "ken-start") throw new KenLifecycleBusyError();
      const lease = !owner && !routeAcquiresLease ? deps.mutations.tryAcquire("ken-transition") : null;
      transitions++;
      if (!retain) invalidate();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        try { rebind(); }
        finally { transitions--; lease?.release(); }
      };
    },
  };
}
