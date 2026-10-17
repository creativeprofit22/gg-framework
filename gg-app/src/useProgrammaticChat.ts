/* eslint-disable react-hooks/refs -- Moved verbatim from AgentPane: latest-value refs are synced during render and read only in effects/handlers; moving the writes would change timing. */
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import {
  PromptSubmissionError,
  type AgentState,
  type PaneAgentClient,
  type WorkspaceMode,
} from "./agent";
import type { AgentEvents } from "./useAgentEvents";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  canRunProgrammaticSelection,
  canScanProgrammatic,
  canReviewProgrammaticCandidate,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";

interface ProgrammaticChatStateDeps {
  paneId: string;
  generationRef: RefObject<number | null | undefined>;
  promptSessionResetEpochRef: RefObject<number>;
  state: AgentState | null;
  workspaceMode: WorkspaceMode;
}

/** Opportunities panel state, keyed to the pane's current session generation. */
export function useProgrammaticChatState({
  paneId,
  generationRef,
  promptSessionResetEpochRef,
  state,
  workspaceMode,
}: ProgrammaticChatStateDeps) {
  const programmaticGeneration = `${paneId}:${generationRef.current}:${promptSessionResetEpochRef.current}:${state?.cwd}:${state?.conversationId}:${state?.sessionId}:${workspaceMode}`;
  const [programmaticOpen, setProgrammaticOpen] = useState(false);
  const [programmatic, dispatchProgrammatic] = useReducer(
    programmaticChatReducer,
    programmaticGeneration,
    initialProgrammaticChatState,
  );
  const programmaticRef = useRef(programmatic);
  programmaticRef.current = programmatic;
  const programmaticTargetRef = useRef(programmaticGeneration);
  programmaticTargetRef.current = programmaticGeneration;
  const programmaticEpochRef = useRef(0);
  const programmaticOwnerRef = useRef<number | null>(null);
  const programmaticRefreshPendingRef = useRef(false);
  const [programmaticInvalidation, invalidateProgrammatic] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const onProgrammaticAssessment = useCallback(
    (event: ProgrammaticAssessmentEvent) => {
      if (workspaceMode !== "code") return;
      dispatchProgrammatic({
        type: "assessment",
        generation: programmaticTargetRef.current,
        event,
      });
      setProgrammaticOpen(true);
      // A button request owns its exact response until it settles. Its normal
      // run-end refresh is already deferred; do not schedule a competing report.
      if (programmaticOwnerRef.current === null) invalidateProgrammatic();
    },
    [workspaceMode],
  );
  const onProgrammaticActivity = useCallback(
    (open: boolean) => {
      if (workspaceMode !== "code") return;
      if (open) setProgrammaticOpen(true);
      invalidateProgrammatic();
    },
    [workspaceMode],
  );
  useEffect(() => {
    programmaticEpochRef.current++;
    programmaticOwnerRef.current = null;
    programmaticRefreshPendingRef.current = false;
    dispatchProgrammatic({ type: "reset", generation: programmaticGeneration });
    setProgrammaticOpen(false);
  }, [programmaticGeneration]);

  return {
    programmaticGeneration,
    programmaticOpen,
    setProgrammaticOpen,
    programmatic,
    dispatchProgrammatic,
    programmaticRef,
    programmaticTargetRef,
    programmaticEpochRef,
    programmaticOwnerRef,
    programmaticRefreshPendingRef,
    programmaticInvalidation,
    invalidateProgrammatic,
    onProgrammaticAssessment,
    onProgrammaticActivity,
  };
}

interface ProgrammaticChatActionsDeps {
  chat: {
    programmaticOpen: boolean;
    dispatchProgrammatic: ReturnType<typeof useProgrammaticChatState>["dispatchProgrammatic"];
    programmaticRef: RefObject<ProgrammaticChatState>;
    programmaticTargetRef: RefObject<string>;
    programmaticEpochRef: RefObject<number>;
    programmaticOwnerRef: RefObject<number | null>;
    programmaticRefreshPendingRef: RefObject<boolean>;
    programmaticInvalidation: number;
    invalidateProgrammatic: () => void;
  };
  client: Pick<PaneAgentClient, "programmatic" | "sendPrompt">;
  workspaceMode: WorkspaceMode;
  hydrated: boolean;
  hydrateNonce: number;
  running: boolean;
  planGateBusy: boolean;
  autopilotReviewing: boolean;
  kenRunning: boolean;
  planMode: boolean | undefined;
  stateRef: RefObject<AgentState | null>;
  lifecycleEpochRef: RefObject<number>;
  mountedRef: RefObject<boolean>;
  refreshCommands: () => Promise<unknown>;
  acceptSubmission: AgentEvents["acceptSubmission"];
  nextId: () => number;
}

/** Opportunities requests and runs; needs `acceptSubmission`, so it follows useAgentEvents. */
export function useProgrammaticChatActions({
  chat: {
    programmaticOpen,
    dispatchProgrammatic,
    programmaticRef,
    programmaticTargetRef,
    programmaticEpochRef,
    programmaticOwnerRef,
    programmaticRefreshPendingRef,
    programmaticInvalidation,
    invalidateProgrammatic,
  },
  client,
  workspaceMode,
  hydrated,
  hydrateNonce,
  running,
  planGateBusy,
  autopilotReviewing,
  kenRunning,
  planMode,
  stateRef,
  lifecycleEpochRef,
  mountedRef,
  refreshCommands,
  acceptSubmission,
  nextId,
}: ProgrammaticChatActionsDeps) {
  const programmaticBusy = running || planGateBusy || autopilotReviewing || kenRunning;
  const releaseProgrammaticOwner = (owner: number, current: boolean): void => {
    if (programmaticOwnerRef.current !== owner) return;
    programmaticOwnerRef.current = null;
    const pending = programmaticRefreshPendingRef.current;
    programmaticRefreshPendingRef.current = false;
    if (current && pending) invalidateProgrammatic();
  };
  const performProgrammatic = async (request: ProgrammaticChatRequest): Promise<void> => {
    if (
      ["inspect-setup", "discover", "review-candidate"].includes(request.action) &&
      stateRef.current?.planMode
    )
      return;
    const selection = programmaticRef.current;
    if (
      request.action === "approve-setup" &&
      (!selection.proposalApprovable ||
        selection.proposal?.handle !== request.proposalHandle ||
        selection.reconcile ||
        selection.operation !== null)
    )
      return;
    if (request.action === "scan" && !canScanProgrammatic(selection)) return;
    if (
      request.action === "review-candidate" &&
      (!canReviewProgrammaticCandidate(selection) ||
        request.source !== "current" ||
        request.candidateId !== selection.candidateDetail?.candidateId ||
        request.assessmentId !== selection.candidateDetail.assessmentId ||
        request.expectedRevision !== selection.candidateDetail.revision)
    )
      return;
    if (
      request.action === "dismiss" &&
      (selection.detail?.summary.actions?.dismiss.available !== true ||
        selection.detail.summary.id !== request.id ||
        selection.detailSnapshot !== request.snapshot ||
        selection.report?.snapshot !== request.snapshot)
    )
      return;
    if (
      workspaceMode !== "code" ||
      !hydrated ||
      programmaticBusy ||
      programmaticOwnerRef.current !== null
    )
      return;
    const generation = programmaticTargetRef.current;
    const owner = ++programmaticEpochRef.current;
    const lifecycle = lifecycleEpochRef.current;
    programmaticOwnerRef.current = owner;
    const current = () =>
      mountedRef.current &&
      lifecycleEpochRef.current === lifecycle &&
      programmaticTargetRef.current === generation &&
      programmaticOwnerRef.current === owner;
    let pending: ProgrammaticChatRequest | null = request;
    try {
      while (pending && current()) {
        const active: ProgrammaticChatRequest = { ...pending };
        const epoch = ++programmaticEpochRef.current;
        const requestId =
          active.action === "discover" ||
          active.action === "inspect-setup" ||
          active.action === "scan"
            ? (active.requestId = crypto.randomUUID())
            : undefined;
        const { sessionId, conversationId } = stateRef.current ?? {};
        const assessmentRequest =
          requestId && sessionId && conversationId
            ? { requestId, sessionId, conversationId }
            : undefined;
        dispatchProgrammatic({
          type: "start",
          generation,
          epoch,
          operation: active.action,
          assessmentRequest,
        });
        const response = await client.programmatic(active);
        if (!current()) return;
        dispatchProgrammatic({ type: "response", generation, epoch, response });
        if (!response.ok) return;
        // Provider-backed setup emits run_end before its native response settles.
        // Its exact proposal is newer than that queued report refresh; retain it
        // until an explicit refresh or a subsequent independent run invalidates it.
        if (active.action === "inspect-setup") programmaticRefreshPendingRef.current = false;
        pending = null;
        if (["approve-setup", "scan", "dismiss"].includes(active.action))
          pending = {
            version: 1,
            action: "report",
            offset: programmaticRef.current.report?.offset ?? 0,
          };
        else if (active.action === "report" && programmaticRef.current.selectedId)
          pending = { version: 1, action: "detail", id: programmaticRef.current.selectedId };
      }
    } catch {
      if (current())
        dispatchProgrammatic({
          type: "error",
          generation,
          epoch: programmaticEpochRef.current,
          error: "The request failed. Reload results to check what happened before trying again.",
          reconcile: [
            "approve-setup",
            "scan",
            "dismiss",
            "history-apply",
            "review-candidate",
          ].includes(request.action),
        });
    } finally {
      // The dedicated approval endpoint does not emit a normal agent run_end.
      // A lost response can still follow a successful save, so refresh on either outcome.
      if (current() && request.action === "approve-setup") void refreshCommands();
      releaseProgrammaticOwner(owner, current());
    }
  };
  const programmaticRefreshRef = useRef(performProgrammatic);
  programmaticRefreshRef.current = performProgrammatic;
  useEffect(() => {
    if (programmaticOpen && workspaceMode === "code" && hydrated && !programmaticBusy) {
      if (programmaticOwnerRef.current !== null) {
        programmaticRefreshPendingRef.current = true;
        return;
      }
      void programmaticRefreshRef.current({
        version: 1,
        action: "report",
        offset: programmaticRef.current.report?.offset ?? 0,
      });
    }
  }, [
    programmaticOpen,
    programmaticInvalidation,
    workspaceMode,
    hydrated,
    hydrateNonce,
    programmaticBusy,
    // Stable refs from useProgrammaticChatState; listed for exhaustive-deps only.
    programmaticOwnerRef,
    programmaticRef,
    programmaticRefreshPendingRef,
  ]);
  const runSelectedProgrammatic = async (): Promise<void> => {
    if (
      workspaceMode !== "code" ||
      planMode ||
      programmaticBusy ||
      programmaticOwnerRef.current !== null ||
      !canRunProgrammaticSelection(programmaticRef.current)
    )
      return;
    const selected = programmaticRef.current;
    const text = `/programmatic-run ${selected.selectedId} ${selected.report!.fingerprint}`;
    const generation = programmaticTargetRef.current;
    const epoch = ++programmaticEpochRef.current;
    const lifecycle = lifecycleEpochRef.current;
    programmaticOwnerRef.current = epoch;
    dispatchProgrammatic({ type: "start", generation, epoch, operation: "run" });
    const current = () =>
      mountedRef.current &&
      lifecycleEpochRef.current === lifecycle &&
      programmaticTargetRef.current === generation &&
      programmaticOwnerRef.current === epoch;
    try {
      const submission = await client.sendPrompt(text);
      if (!current()) return;
      if (submission.queued) throw new Error("Opportunity run unexpectedly queued");
      acceptSubmission({ kind: "user", id: nextId(), text, command: true }, submission);
      dispatchProgrammatic({ type: "run-accepted", generation, epoch });
    } catch (error) {
      const rejected = error instanceof PromptSubmissionError && error.category === "rejected";
      if (current())
        dispatchProgrammatic({
          type: "error",
          generation,
          epoch,
          error: rejected
            ? `Run rejected: ${error.message}`
            : "We could not confirm whether the task started. Reload results before trying again.",
          reconcile: !rejected,
        });
    } finally {
      releaseProgrammaticOwner(epoch, current());
    }
  };

  return { programmaticBusy, performProgrammatic, runSelectedProgrammatic };
}
