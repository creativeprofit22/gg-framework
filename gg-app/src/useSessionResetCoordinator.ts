import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  requireContinuationAcceptedEvent,
  type AgentState,
  type ContinuationCommitRequest,
  type ContinuationDestination,
  type ContinuationHandoffResponse,
} from "./agent";
import type { Item } from "./App";
import {
  SESSION_RESET_TIMEOUT_MS,
  SessionResetConfirmationTimeoutError,
} from "./agent-pane-session-errors";

/** The in-flight continuation handoff, mirrored in AgentPane's `continuationAttemptRef`. */
export interface ContinuationAttempt {
  request: ContinuationCommitRequest;
  prepared: ContinuationHandoffResponse;
  destination?: ContinuationDestination;
  acceptedMessageId?: string;
}

interface SessionResetWaiter {
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * AgentPane keeps owning these refs and setters (hydration, new-session and
 * continuation flows also use them); the hook only receives them.
 */
interface SessionResetCoordinatorDeps {
  observedSessionResetOperationsRef: RefObject<Set<string>>;
  sessionResetOperationWaitersRef: RefObject<Map<string, SessionResetWaiter>>;
  recoveredSessionResetOperationRef: RefObject<string | null>;
  unresolvedSessionResetRef: RefObject<{
    generation: number | null | undefined;
    operationId: string | null;
  } | null>;
  generationRef: RefObject<number | null | undefined>;
  sessionMutationLockRef: RefObject<boolean>;
  stateRef: RefObject<AgentState | null>;
  continuationResetsRef: RefObject<Set<string>>;
  retiredConversationIdsRef: RefObject<Set<string>>;
  continuationAttemptRef: RefObject<ContinuationAttempt | null>;
  appliedContinuationMessagesRef: RefObject<Set<string>>;
  promptSessionResetEpochRef: RefObject<number>;
  promptSubmissionPendingRef: RefObject<(() => boolean) | null>;
  kenCurrentSubmissionRef: RefObject<(() => boolean) | null>;
  setState: Dispatch<SetStateAction<AgentState | null>>;
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
}

/** Matches daemon session-reset and continuation-accepted events to this pane's pending operations. */
export function useSessionResetCoordinator({
  observedSessionResetOperationsRef,
  sessionResetOperationWaitersRef,
  recoveredSessionResetOperationRef,
  unresolvedSessionResetRef,
  generationRef,
  sessionMutationLockRef,
  stateRef,
  continuationResetsRef,
  retiredConversationIdsRef,
  continuationAttemptRef,
  appliedContinuationMessagesRef,
  promptSessionResetEpochRef,
  promptSubmissionPendingRef,
  kenCurrentSubmissionRef,
  setState,
  setItems,
  nextId,
}: SessionResetCoordinatorDeps) {
  const registerSessionResetOperationWaiter = useCallback(
    (operationId: string) => {
      if (observedSessionResetOperationsRef.current.delete(operationId)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!sessionResetOperationWaitersRef.current.delete(operationId)) return;
          reject(new SessionResetConfirmationTimeoutError(operationId));
        }, SESSION_RESET_TIMEOUT_MS);
        sessionResetOperationWaitersRef.current.set(operationId, { resolve, reject, timeout });
      });
    },
    [observedSessionResetOperationsRef, sessionResetOperationWaitersRef],
  );

  const shouldApplySessionReset = useCallback(
    (data: Record<string, unknown>): boolean => {
      const operationId = typeof data.operationId === "string" ? data.operationId : undefined;
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      if (operationId && recoveredSessionResetOperationRef.current === operationId) return false;
      const unresolved = unresolvedSessionResetRef.current;
      if (
        unresolved &&
        (unresolved.generation !== generationRef.current ||
          (unresolved.operationId === null
            ? !sessionMutationLockRef.current
            : operationId !== unresolved.operationId) ||
          !operationId ||
          !conversationId ||
          !sessionId ||
          conversationId === stateRef.current?.conversationId)
      )
        return false;
      if (operationId && continuationResetsRef.current.has(operationId)) return false;
      if (conversationId && retiredConversationIdsRef.current.has(conversationId)) return false;
      const attempt = continuationAttemptRef.current;
      if (sessionMutationLockRef.current && attempt && operationId !== attempt.request.operationId)
        return false;
      if (attempt && operationId === attempt.request.operationId) {
        if (
          !conversationId ||
          !sessionId ||
          conversationId === attempt.prepared.source.conversationId
        )
          return false;
        if (
          attempt.destination &&
          (attempt.destination.conversationId !== conversationId ||
            attempt.destination.sessionId !== sessionId)
        )
          return false;
        continuationResetsRef.current.add(operationId);
        if (continuationResetsRef.current.size > 32)
          continuationResetsRef.current.delete(
            continuationResetsRef.current.values().next().value!,
          );
        attempt.destination = {
          conversationId,
          sessionId,
          profile:
            attempt.request.profile ?? stateRef.current?.openAICodexContextProfile ?? "stable",
        };
      }
      if (conversationId && sessionId) {
        const previous = stateRef.current;
        if (previous?.conversationId && previous.conversationId !== conversationId) {
          retiredConversationIdsRef.current.add(previous.conversationId);
          if (retiredConversationIdsRef.current.size > 32)
            retiredConversationIdsRef.current.delete(
              retiredConversationIdsRef.current.values().next().value!,
            );
        }
        if (previous) stateRef.current = { ...previous, conversationId, sessionId };
        setState((current) => (current ? { ...current, conversationId, sessionId } : current));
      }
      return true;
    },
    [
      continuationAttemptRef,
      continuationResetsRef,
      generationRef,
      recoveredSessionResetOperationRef,
      retiredConversationIdsRef,
      sessionMutationLockRef,
      setState,
      stateRef,
      unresolvedSessionResetRef,
    ],
  );

  const onContinuationAccepted = useCallback(
    (data: unknown) => {
      let event;
      try {
        event = requireContinuationAcceptedEvent(data);
      } catch {
        return;
      }
      const attempt = continuationAttemptRef.current;
      const current = stateRef.current;
      if (
        !attempt ||
        event.operationId !== attempt.request.operationId ||
        event.preparedId !== attempt.request.preparedId ||
        current?.conversationId !== event.destination.conversationId ||
        current.sessionId !== event.destination.sessionId ||
        !continuationResetsRef.current.has(event.operationId) ||
        (attempt.request.profile && attempt.request.profile !== event.destination.profile) ||
        (attempt.acceptedMessageId && attempt.acceptedMessageId !== event.acceptedMessageId) ||
        event.prompt !== attempt.prepared.prompt
      )
        return;
      attempt.destination = event.destination;
      attempt.acceptedMessageId = event.acceptedMessageId;
      const key = `${event.destination.conversationId}:${event.acceptedMessageId}`;
      if (appliedContinuationMessagesRef.current.has(key)) return;
      appliedContinuationMessagesRef.current.add(key);
      if (appliedContinuationMessagesRef.current.size > 32)
        appliedContinuationMessagesRef.current.delete(
          appliedContinuationMessagesRef.current.values().next().value!,
        );
      setItems((currentItems) => [
        ...currentItems,
        {
          kind: "user",
          id: nextId(),
          text: attempt.prepared.prompt,
          kenSent: true,
          acceptedMessageId: event.acceptedMessageId,
        },
      ]);
    },
    [
      appliedContinuationMessagesRef,
      continuationAttemptRef,
      continuationResetsRef,
      nextId,
      setItems,
      stateRef,
    ],
  );

  const onAuthoritativeSessionReset = useCallback(
    (operationId?: string) => {
      // Resets can replace a conversation without changing the native generation
      // or hydration epoch, and older reset events need not carry an operation id.
      promptSessionResetEpochRef.current += 1;
      promptSubmissionPendingRef.current = null;
      kenCurrentSubmissionRef.current = null;
      if (!operationId) return;
      const unresolved = unresolvedSessionResetRef.current;
      if (
        unresolved?.operationId === operationId &&
        unresolved.generation === generationRef.current
      ) {
        unresolvedSessionResetRef.current = null;
      }
      recoveredSessionResetOperationRef.current = operationId;
      const waiter = sessionResetOperationWaitersRef.current.get(operationId);
      if (waiter) {
        sessionResetOperationWaitersRef.current.delete(operationId);
        clearTimeout(waiter.timeout);
        waiter.resolve();
        return;
      }
      observedSessionResetOperationsRef.current.add(operationId);
      if (observedSessionResetOperationsRef.current.size > 32) {
        const oldest = observedSessionResetOperationsRef.current.values().next().value;
        if (oldest) observedSessionResetOperationsRef.current.delete(oldest);
      }
    },
    [
      generationRef,
      kenCurrentSubmissionRef,
      observedSessionResetOperationsRef,
      promptSessionResetEpochRef,
      promptSubmissionPendingRef,
      recoveredSessionResetOperationRef,
      sessionResetOperationWaitersRef,
      unresolvedSessionResetRef,
    ],
  );

  useEffect(
    () => () => {
      for (const waiter of sessionResetOperationWaitersRef.current.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("The pane closed before the new session was confirmed."));
      }
      sessionResetOperationWaitersRef.current.clear();
      observedSessionResetOperationsRef.current.clear();
    },
    [observedSessionResetOperationsRef, sessionResetOperationWaitersRef],
  );

  return {
    registerSessionResetOperationWaiter,
    shouldApplySessionReset,
    onContinuationAccepted,
    onAuthoritativeSessionReset,
  };
}
