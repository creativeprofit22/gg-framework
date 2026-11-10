import { phaseStartPrerequisiteConfirmation } from "@kenkaiiii/gg-core/roadmap-phase-dependencies";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NotesPhase,
  PhaseStartOptions,
  PhaseStartPrerequisite,
  PhaseStartResult,
} from "../notes-types";

export interface StartPrerequisiteRequest {
  phaseTitle: string;
  prerequisites: PhaseStartPrerequisite[];
  /** True when the daemon found a different unfinished set than the one confirmed. */
  stale: boolean;
}

type StartPhase = (phaseId: string, options?: PhaseStartOptions) => Promise<PhaseStartResult>;

/** Soft gate for manual Start: confirm unfinished prerequisites first. Resolves null on Cancel. */
export function useStartPrerequisiteGate(
  phases: readonly NotesPhase[],
  onStartPhase: StartPhase,
  projectKey: string | null,
) {
  const [request, setRequest] = useState<StartPrerequisiteRequest | null>(null);
  const phasesRef = useRef(phases);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    phasesRef.current = phases;
  }, [phases]);

  const settle = useCallback((confirmed: boolean): void => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    const generation = epoch;
    const pending = resolver;
    generation.current++;
    settle(false);
    return () => {
      generation.current++;
      pending.current?.(false);
      pending.current = null;
    };
  }, [projectKey, settle]);

  const ask = (next: StartPrerequisiteRequest): Promise<boolean> =>
    new Promise((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setRequest(next);
    });

  const start = async (phaseId: string): Promise<PhaseStartResult | null> => {
    const current = phasesRef.current;
    const phase = current.find((candidate) => candidate.id === phaseId);
    const needed = phaseStartPrerequisiteConfirmation(current, phaseId, []);
    if (!phase || !needed) return onStartPhase(phaseId);
    const generation = ++epoch.current;
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let prerequisites = needed.prerequisites;
    let stale = false;
    for (;;) {
      const confirmed = await ask({ phaseTitle: phase.title, prerequisites, stale });
      if (generation !== epoch.current) return null;
      if (!confirmed) {
        // The invoker is disabled while the dialog is open; refocus once it is enabled again.
        requestAnimationFrame(() => {
          if (invoker.current?.isConnected) invoker.current.focus();
        });
        return null;
      }
      const result = await onStartPhase(phaseId, {
        confirmedPrerequisiteIds: prerequisites.map((prerequisite) => prerequisite.id),
      });
      if (
        generation !== epoch.current ||
        result.status !== "failed" ||
        result.code !== "prerequisites-confirmation-required" ||
        !result.prerequisites
      ) {
        return result;
      }
      prerequisites = result.prerequisites;
      stale = true;
    }
  };

  return {
    start,
    request,
    cancel: () => settle(false),
    confirm: () => settle(true),
  };
}

export type StartPrerequisiteGate = ReturnType<typeof useStartPrerequisiteGate>;
