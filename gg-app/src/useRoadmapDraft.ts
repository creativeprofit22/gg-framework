import { useCallback, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { PaneAgentClient } from "./agent";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import {
  initialRoadmapPhaseDraftState,
  normalizeRoadmapPhaseDraft,
  reduceRoadmapPhaseDraftState,
  type RoadmapPhaseDraftAction,
} from "./roadmap-phase-draft-state";

/** One reducer and one coalesced IPC reader per pane/session/project generation. */
export function useRoadmapDraft(client: PaneAgentClient, scope: string, hydrated: boolean) {
  const [state, send] = useReducer(reduceRoadmapPhaseDraftState, initialRoadmapPhaseDraftState);
  const currentState = useRef(state);
  const dispatch = useCallback((action: RoadmapPhaseDraftAction) => {
    currentState.current = reduceRoadmapPhaseDraftState(currentState.current, action);
    send(action);
  }, []);
  const generationRef = useRef<{
    client: PaneAgentClient;
    scope: string;
    active: boolean;
    pending: boolean;
    again: boolean;
    deciding: boolean;
  } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const generation = { client, scope, active: true, pending: false, again: false, deciding: false };
    generationRef.current = generation;
    dispatch({ type: "reset" });
    setRefreshError(null);
    return () => {
      generation.active = false;
    };
  }, [client, scope, dispatch]);

  const refresh = useCallback(() => {
    const generation = generationRef.current;
    if (!generation?.active || generation.client !== client || generation.scope !== scope) return;
    if (generation.pending) {
      generation.again = true;
      return;
    }
    generation.pending = true;
    void (async () => {
      do {
        generation.again = false;
        const startedAtEventVersion = currentState.current.eventVersion;
        try {
          const value = await client.getRoadmapPhaseDraft();
          const draft = value === null ? null : normalizeRoadmapPhaseDraft(value);
          if (value !== null && !draft)
            throw new Error("Invalid Roadmap draft response. Try again.");
          if (!generation.active) return;
          dispatch({ type: "hydrated", draft, startedAtEventVersion });
          setRefreshError(null);
        } catch (error) {
          if (!generation.active) return;
          if (startedAtEventVersion === currentState.current.eventVersion)
            setRefreshError(error instanceof Error ? error.message : String(error));
        }
      } while (generation.active && generation.again);
      generation.pending = false;
    })();
  }, [client, scope, dispatch]);
  useLayoutEffect(() => {
    if (hydrated) refresh();
  }, [hydrated, refresh]);

  const onChange = useCallback(
    (draft: RoadmapPhaseDraft | null) => {
      const generation = generationRef.current;
      if (!generation?.active || generation.client !== client || generation.scope !== scope) return;
      dispatch({ type: "event", draft });
    },
    [client, scope, dispatch],
  );
  const decide = useCallback(
    (decision: "approving" | "rejecting") => {
      const generation = generationRef.current;
      if (!generation?.active || generation.client !== client || generation.scope !== scope) return;
      const draftId = currentState.current.draft?.id;
      if (!draftId || generation.deciding || currentState.current.decision !== "idle") return;
      generation.deciding = true;
      dispatch({ type: "decision-started", decision });
      const isCurrent = () => generation.active && currentState.current.draft?.id === draftId;
      void (async () => {
        try {
          if (decision === "approving") {
            const result = await client.approveRoadmapPhaseDraft(draftId);
            if (isCurrent()) dispatch({ type: "approval-result", result });
          } else {
            const result = await client.rejectRoadmapPhaseDraft(draftId);
            if (isCurrent()) dispatch({ type: "rejection-result", result });
          }
        } catch (error) {
          if (isCurrent())
            dispatch({
              type: "failed",
              message: error instanceof Error ? error.message : String(error),
            });
        } finally {
          generation.deciding = false;
        }
      })();
    },
    [client, scope, dispatch],
  );
  return {
    state,
    dispatch,
    refresh,
    refreshError,
    onChange,
    approve: () => decide("approving"),
    reject: () => decide("rejecting"),
  };
}
