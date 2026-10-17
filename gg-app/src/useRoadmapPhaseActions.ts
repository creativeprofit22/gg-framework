import { useCallback, type RefObject } from "react";
import type { AgentState, PaneAgentClient } from "./agent";
import type { NotesSessionLink, PhaseStartResult } from "./notes-types";
import { resolveRoadmapPhaseResumeFromNotes } from "./roadmap-phase-resume";

interface RoadmapPhaseActionsDeps {
  state: AgentState | null;
  stateRef: RefObject<AgentState | null>;
  generationRef: RefObject<number | null | undefined>;
  client: Pick<PaneAgentClient, "getNotes" | "selectWorkspace" | "startPhase">;
  running: boolean;
  autopilotReviewing: boolean;
  newSessionBusy: boolean;
  blockUnconfirmedSession: () => boolean;
  adoptGeneration: (generation: number) => void;
  /** AgentPane's re-hydrate entry point; captured with the callback exactly as before. */
  onProjectChosen: () => void;
}

/** Start and resume Roadmap phases from the Notes panel in this pane's coding session. */
export function useRoadmapPhaseActions({
  state,
  stateRef,
  generationRef,
  client,
  running,
  autopilotReviewing,
  newSessionBusy,
  blockUnconfirmedSession,
  adoptGeneration,
  onProjectChosen,
}: RoadmapPhaseActionsDeps) {
  const startRoadmapPhase = useCallback(
    async (phaseId: string): Promise<PhaseStartResult> => {
      if (state?.mode !== "code") {
        return {
          status: "failed",
          code: "coding-mode-required",
          operationId: null,
          message: "Roadmap phases can only start in coding mode.",
        };
      }
      if (blockUnconfirmedSession() || running || autopilotReviewing || newSessionBusy) {
        return {
          status: "failed",
          code: "session-busy",
          operationId: null,
          message: "Wait for the current run or Autopilot review to finish.",
        };
      }
      return client.startPhase(phaseId);
    },
    // blockUnconfirmedSession is []-memoized in AgentPane, so listing it keeps the identity unchanged.
    [autopilotReviewing, blockUnconfirmedSession, client, newSessionBusy, running, state?.mode],
  );

  const resumeRoadmapPhase = useCallback(
    async (phaseId: string, link: NotesSessionLink): Promise<void> => {
      if (running || autopilotReviewing || newSessionBusy) {
        throw new Error("Wait for the current run or Autopilot review to finish.");
      }
      const currentCwd = stateRef.current?.cwd;
      if (!currentCwd) throw new Error("The project session is not ready.");
      const resolution = await resolveRoadmapPhaseResumeFromNotes(client, phaseId, link);
      if (resolution.status === "blocked") throw new Error(resolution.message);
      link = resolution.session;
      if (link.sessionPath === null) {
        const recovered = await startRoadmapPhase(phaseId);
        if (recovered.status === "failed") throw new Error(recovered.message);
        if (recovered.status === "accepted") return;
        link = recovered.session;
      }
      if (link.sessionPath === null) {
        throw new Error("This phase has no resumable session file.");
      }
      const nextGeneration = await client.selectWorkspace(
        { mode: "code", cwd: currentCwd, sessionPath: link.sessionPath },
        generationRef.current ?? 0,
      );
      adoptGeneration(nextGeneration);
      // onProjectChosen owns the single readiness + hydration pass for this session.
      onProjectChosen();
    },
    // onProjectChosen is a per-render function in AgentPane that was never a dependency;
    // omitting it preserves this callback's identity. The refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      adoptGeneration,
      autopilotReviewing,
      client,
      generationRef,
      newSessionBusy,
      running,
      startRoadmapPhase,
      stateRef,
    ],
  );

  return { startRoadmapPhase, resumeRoadmapPhase };
}
