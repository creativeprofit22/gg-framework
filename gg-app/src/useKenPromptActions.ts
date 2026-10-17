import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { NewSessionError, type AgentState, type PaneAgentClient } from "./agent";
import {
  AUTOPILOT_NEW_SESSION_RETRY_MESSAGE,
  LocalSessionMutationBusyError,
  SESSION_RESET_TIMEOUT_MS,
  SessionResetConfirmationTimeoutError,
} from "./agent-pane-session-errors";
import type { ContinuationConfirmationState } from "./ContinuationConfirmationModal";
import type { KenPromptActionResult } from "./ken-prompt-actions";
import type { AgentEvents } from "./useAgentEvents";
import type { ContinuationAttempt, useSessionResetCoordinator } from "./useSessionResetCoordinator";

/**
 * AgentPane keeps owning these refs, state and setters (hydration, Ken prompt
 * dispatch and the new-session button also use them); the hook only receives them.
 */
interface KenPromptActionsDeps {
  running: boolean;
  autopilotReviewing: boolean;
  newSessionBusy: boolean;
  setNewSessionBusy: Dispatch<SetStateAction<boolean>>;
  sessionMutationLockRef: RefObject<boolean>;
  unresolvedSessionResetRef: RefObject<{
    generation: number | null | undefined;
    operationId: string | null;
  } | null>;
  generationRef: RefObject<number | null | undefined>;
  observedSessionResetOperationsRef: RefObject<Set<string>>;
  recoveredSessionResetOperationRef: RefObject<string | null>;
  retiredConversationIdsRef: RefObject<Set<string>>;
  stateRef: RefObject<AgentState | null>;
  setState: Dispatch<SetStateAction<AgentState | null>>;
  continuationAttemptRef: RefObject<ContinuationAttempt | null>;
  continuationResetsRef: RefObject<Set<string>>;
  sessionResetOperationWaitersRef: RefObject<
    Map<
      string,
      { resolve(): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
    >
  >;
  setContinuationConfirmation: Dispatch<SetStateAction<ContinuationConfirmationState | null>>;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  newSession: PaneAgentClient["newSession"];
  getState: PaneAgentClient["getState"];
  commitContinuation: PaneAgentClient["commitContinuation"];
  waitForReady: () => Promise<void>;
  handleEvent: AgentEvents["handleEvent"];
  blockUnconfirmedSession: () => boolean;
  registerSessionResetOperationWaiter: ReturnType<
    typeof useSessionResetCoordinator
  >["registerSessionResetOperationWaiter"];
}

/** Authoritative new-session and prepared-continuation commits behind Ken prompt actions. */
export function useKenPromptActions({
  running,
  autopilotReviewing,
  newSessionBusy,
  setNewSessionBusy,
  sessionMutationLockRef,
  unresolvedSessionResetRef,
  generationRef,
  observedSessionResetOperationsRef,
  recoveredSessionResetOperationRef,
  retiredConversationIdsRef,
  stateRef,
  setState,
  continuationAttemptRef,
  continuationResetsRef,
  sessionResetOperationWaitersRef,
  setContinuationConfirmation,
  setInput,
  inputRef,
  newSession,
  getState,
  commitContinuation,
  waitForReady,
  handleEvent,
  blockUnconfirmedSession,
  registerSessionResetOperationWaiter,
}: KenPromptActionsDeps) {
  const createAuthoritativeNewSession = useCallback(async (): Promise<string> => {
    if (running) throw new LocalSessionMutationBusyError();
    if (autopilotReviewing) throw new Error(AUTOPILOT_NEW_SESSION_RETRY_MESSAGE);
    if (newSessionBusy || sessionMutationLockRef.current) {
      throw new LocalSessionMutationBusyError();
    }
    if (unresolvedSessionResetRef.current) {
      throw new SessionResetConfirmationTimeoutError(
        unresolvedSessionResetRef.current.operationId ?? "",
      );
    }
    sessionMutationLockRef.current = true;
    setNewSessionBusy(true);
    const pending = { generation: generationRef.current, operationId: null as string | null };
    unresolvedSessionResetRef.current = pending;
    try {
      const generation = pending.generation;
      const { operationId } = await newSession();
      pending.operationId = operationId;
      await waitForReady();
      try {
        await registerSessionResetOperationWaiter(operationId);
      } catch (error) {
        if (!(error instanceof SessionResetConfirmationTimeoutError)) throw error;
        // Recover only this completed operation, never retry the destructive reset.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const snapshot = await Promise.race([
          getState().catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), SESSION_RESET_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (generationRef.current !== generation) throw error;
        // The real event may have arrived while the state read was in flight.
        if (!observedSessionResetOperationsRef.current.delete(operationId)) {
          const receipt = snapshot?.lastNewSessionReset;
          if (
            !snapshot ||
            receipt?.operationId !== operationId ||
            typeof receipt.conversationId !== "string" ||
            !receipt.conversationId ||
            typeof receipt.sessionId !== "string" ||
            !receipt.sessionId ||
            receipt.conversationId !== snapshot.conversationId ||
            receipt.sessionId !== snapshot.sessionId ||
            retiredConversationIdsRef.current.has(receipt.conversationId)
          ) {
            throw error;
          }
          handleEvent({ type: "session_reset", data: { ...receipt, kenState: snapshot.kenState } });
          if (!observedSessionResetOperationsRef.current.delete(operationId)) throw error;
          recoveredSessionResetOperationRef.current = operationId;
          stateRef.current = snapshot;
          setState(snapshot);
        }
      }
      if (generationRef.current !== generation)
        throw new SessionResetConfirmationTimeoutError(operationId);
      if (unresolvedSessionResetRef.current === pending) unresolvedSessionResetRef.current = null;
      recoveredSessionResetOperationRef.current = operationId;
      return operationId;
    } catch (error) {
      if (
        error instanceof NewSessionError &&
        error.kind === "creation-rejected" &&
        unresolvedSessionResetRef.current === pending
      ) {
        unresolvedSessionResetRef.current = null;
      }
      throw error;
    } finally {
      sessionMutationLockRef.current = false;
      setNewSessionBusy(false);
    }
  }, [
    autopilotReviewing,
    newSession,
    newSessionBusy,
    getState,
    handleEvent,
    registerSessionResetOperationWaiter,
    running,
    waitForReady,
    // Stable refs and setters owned by AgentPane; listing them keeps the identity unchanged.
    generationRef,
    observedSessionResetOperationsRef,
    recoveredSessionResetOperationRef,
    retiredConversationIdsRef,
    sessionMutationLockRef,
    setNewSessionBusy,
    setState,
    stateRef,
    unresolvedSessionResetRef,
  ]);

  const restorePromptToComposer = useCallback(
    (prompt: string) => {
      setInput(prompt);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(prompt.length, prompt.length);
      });
    },
    // Stable ref and setter owned by AgentPane.
    [inputRef, setInput],
  );

  const commitPreparedContinuation = useCallback(
    async (ownsLock = false): Promise<KenPromptActionResult> => {
      const attempt = continuationAttemptRef.current;
      if (blockUnconfirmedSession() || !attempt || (!ownsLock && sessionMutationLockRef.current))
        return { status: "cancelled" };
      sessionMutationLockRef.current = true;
      setNewSessionBusy(true);
      setContinuationConfirmation((current) =>
        current ? { ...current, busy: true, error: undefined } : current,
      );
      // Attach the rejection handler immediately: an HTTP request may outlive the reset timeout.
      const reset = registerSessionResetOperationWaiter(attempt.request.operationId).then(
        () => true,
        () => false,
      );
      const recover = (message: string, retry: boolean): KenPromptActionResult => {
        restorePromptToComposer(attempt.prepared.prompt);
        setContinuationConfirmation((current) =>
          current ? { ...current, busy: false, retry, error: message } : current,
        );
        return {
          status: "failed",
          action: "send-fresh",
          message,
          recoverPrompt: attempt.prepared.prompt,
        };
      };
      let receiptAccepted = false;
      try {
        const receipt = await commitContinuation(attempt.request);
        receiptAccepted = receipt.outcome === "accepted";
        if (receipt.outcome !== "accepted") {
          const acceptance = attempt.acceptedMessageId
            ? "Acceptance was observed in the session event."
            : receipt.accepted === false
              ? "No continuation was accepted."
              : "Acceptance is unknown. Do not resend the composer automatically.";
          const actualMode = receipt.destination
            ? ` Reported destination context mode: ${receipt.destination.profile}.`
            : "";
          return recover(
            `${receipt.message ?? receipt.error ?? receipt.outcome}. ${acceptance} ${receipt.resetAttempted ? "A destination reset was attempted; inspect the active session." : "No destination reset was attempted."}${actualMode}`,
            receipt.outcome === "outcome-unknown",
          );
        }
        const destination = receipt.destination;
        if (
          attempt.destination &&
          (attempt.destination.conversationId !== destination.conversationId ||
            attempt.destination.sessionId !== destination.sessionId)
        ) {
          return recover(
            "The server reports acceptance in a different destination than the observed reset. Inspect Sessions; no additional local message was added.",
            false,
          );
        }
        attempt.destination = destination;
        await waitForReady();
        const resetObserved =
          continuationResetsRef.current.has(attempt.request.operationId) || (await reset);
        const current = await getState();
        if (
          !resetObserved ||
          current.conversationId !== destination.conversationId ||
          current.sessionId !== destination.sessionId ||
          current.openAICodexContextProfile !== destination.profile ||
          (attempt.request.profile && attempt.request.profile !== destination.profile) ||
          (attempt.acceptedMessageId && attempt.acceptedMessageId !== receipt.acceptedMessageId)
        ) {
          return recover(
            "The server accepted the continuation, but the active destination could not be verified. No additional local message was added. Inspect Sessions before taking further action.",
            false,
          );
        }
        // SSE owns insertion; a late receipt must not append a user bubble after assistant deltas.
        if (!attempt.acceptedMessageId)
          return recover(
            "The server accepted the continuation, but its transcript event was not observed. No local message was added. Refresh or inspect the destination session; do not resend the composer.",
            false,
          );
        setContinuationConfirmation(null);
        return { status: "sent", session: "fresh" };
      } catch {
        if (receiptAccepted) {
          return recover(
            "The server accepted the continuation, but refreshing the destination failed. Inspect Sessions; do not resend the composer. No additional local message was added.",
            false,
          );
        }
        return recover(
          attempt.acceptedMessageId
            ? "The continuation was accepted in the session event, but its receipt was not received. Check outcome to retrieve the same operation receipt; do not resend the composer."
            : "The commit outcome is unknown. Check outcome retries only this same operation; do not resend the composer.",
          true,
        );
      } finally {
        const waiter = sessionResetOperationWaitersRef.current.get(attempt.request.operationId);
        if (waiter) {
          clearTimeout(waiter.timeout);
          sessionResetOperationWaitersRef.current.delete(attempt.request.operationId);
          waiter.resolve();
        }
        sessionMutationLockRef.current = false;
        setNewSessionBusy(false);
      }
    },
    [
      commitContinuation,
      getState,
      registerSessionResetOperationWaiter,
      restorePromptToComposer,
      waitForReady,
      // Stable refs, setters and the []-memoized guard owned by AgentPane.
      blockUnconfirmedSession,
      continuationAttemptRef,
      continuationResetsRef,
      sessionMutationLockRef,
      sessionResetOperationWaitersRef,
      setContinuationConfirmation,
      setNewSessionBusy,
    ],
  );

  return { createAuthoritativeNewSession, restorePromptToComposer, commitPreparedContinuation };
}
