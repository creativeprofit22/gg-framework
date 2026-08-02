import { randomUUID } from "node:crypto";

export type SessionMutationKind =
  | "new-session"
  | "task-run"
  | "phase-start"
  | "prompt-start"
  | "manual-plan-accept"
  | "autopilot-plan-accept";

export interface SessionMutationOwner {
  operationId: string;
  kind: SessionMutationKind;
}

export interface SessionMutationLease extends SessionMutationOwner {
  release(): void;
}

export interface SessionMutationConflictBody {
  error: "session_mutation_in_progress";
  owner: SessionMutationOwner;
}

export interface AppSidecarSessionBusyState {
  running: boolean;
  autopilotActive: boolean;
  runLifecycleRunning: boolean;
}

export interface AppSidecarSessionBusyConflictBody {
  error: "session_busy";
  message: string;
  state: AppSidecarSessionBusyState;
}

export type AppSidecarNewSessionMutationResult =
  | { status: 200; body: { ok: true; operationId: string } }
  | { status: 409; body: AppSidecarSessionBusyConflictBody | SessionMutationConflictBody }
  | { status: 500; body: { error: string }; error: unknown };

export interface AppSidecarNewSessionMutationOptions {
  busyState: AppSidecarSessionBusyState;
  mutations: AppSidecarSessionMutationCoordinator;
  perform(mutation: SessionMutationOwner): Promise<void>;
}

/** Authoritative gate for reset-style routes that require an idle logical session. */
export function isAppSidecarSessionBusy(state: AppSidecarSessionBusyState): boolean {
  return state.running || state.autopilotActive || state.runLifecycleRunning;
}

export function appSidecarSessionBusyConflictBody(
  state: AppSidecarSessionBusyState,
): AppSidecarSessionBusyConflictBody {
  return {
    error: "session_busy",
    message: "Cannot start a new session while the current session is active.",
    state,
  };
}

/**
 * Executes the authoritative `/new-session` gate, lease, operation, and release contract.
 *
 * Session transitions and prompt acceptance must never queue behind each other:
 * a delayed reset could silently retarget a prompt after its caller has moved on.
 * The current owner completes atomically; competitors receive a typed 409.
 */
export async function runAppSidecarNewSessionMutation(
  options: AppSidecarNewSessionMutationOptions,
): Promise<AppSidecarNewSessionMutationResult> {
  if (isAppSidecarSessionBusy(options.busyState)) {
    return { status: 409, body: appSidecarSessionBusyConflictBody(options.busyState) };
  }
  const mutation = options.mutations.tryAcquire("new-session");
  if (!mutation) return { status: 409, body: options.mutations.conflictBody() };

  try {
    await options.perform({ operationId: mutation.operationId, kind: mutation.kind });
    return { status: 200, body: { ok: true, operationId: mutation.operationId } };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
      error,
    };
  } finally {
    mutation.release();
  }
}

/** Fail-fast lifecycle gate owned by one logical sidecar session. */
export class AppSidecarSessionMutationCoordinator {
  #owner: SessionMutationOwner | null = null;
  readonly #createOperationId: () => string;

  constructor(createOperationId: () => string = randomUUID) {
    this.#createOperationId = createOperationId;
  }

  get owner(): SessionMutationOwner | null {
    return this.#owner ? { ...this.#owner } : null;
  }

  tryAcquire(kind: SessionMutationKind): SessionMutationLease | null {
    if (this.#owner) return null;

    const owner = { operationId: this.#createOperationId(), kind } satisfies SessionMutationOwner;
    this.#owner = owner;
    let released = false;
    return {
      ...owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.#owner?.operationId === owner.operationId) this.#owner = null;
      },
    };
  }

  conflictBody(): SessionMutationConflictBody {
    const owner = this.#owner;
    if (!owner) throw new Error("session mutation conflict requested without an owner");
    return { error: "session_mutation_in_progress", owner: { ...owner } };
  }
}
