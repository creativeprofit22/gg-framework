import { useEffect, useRef, useState } from "react";
import {
  isNotesPhaseDeleted,
  notesPhaseDeletionGeneration,
  type NotesPhase,
  type PhaseDeletionRequest,
  type PhaseDeletionOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";

export interface PhaseDeletionBridge {
  prepare(): Promise<ProjectNotesSnapshot>;
  mutate(request: PhaseDeletionRequest): Promise<PhaseDeletionOutcome>;
}
export function usePhaseDeletion(
  projectKey: string | null,
  bridge?: PhaseDeletionBridge,
  /**
   * Runs in the same update as the adopted snapshot when a delete commits and the phase
   * is now deleted, so a caller can retire its own selection before the phase leaves the
   * list. This is a notification, not a second recovery model: it changes no contract
   * here and never affects dispatch, feedback or focus below.
   */
  onDeleteCommitted?: (phaseId: string) => void,
) {
  const [target, setTarget] = useState<{ phase: NotesPhase; action: "delete" | "recover" } | null>(
    null,
  );
  const [request, setRequest] = useState<PhaseDeletionRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [success, setSuccess] = useState<{
    phase: NotesPhase;
    deletionId: string | null;
    message: string;
  } | null>(null);
  const epoch = useRef(0);
  const dispatched = useRef(false);
  const invoker = useRef<HTMLElement | null>(null);
  const focusCandidates = useRef<string[]>([]);
  useEffect(() => {
    epoch.current++;
    dispatched.current = false;
    setTarget(null);
    setRequest(null);
    setError(null);
    setPending(false);
    setPreparing(false);
    setSuccess(null);
    setUncertain(false);
    return () => {
      epoch.current++;
    };
  }, [projectKey]);
  const begin = async (
    phase: NotesPhase,
    action: "delete" | "recover",
    exactDeletionId?: string,
  ) => {
    if (dispatched.current) return;
    const generation = ++epoch.current;
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget({ phase, action });
    setRequest(null);
    setPreparing(true);
    setError(null);
    setUncertain(false);
    try {
      if (!bridge) throw new Error("Reconnect to Project Notes to use this action.");
      const snapshot = await bridge.prepare();
      if (generation !== epoch.current) return;
      const current = snapshot.document.phases.find((p) => p.id === phase.id);
      if (
        !current ||
        (action === "delete") === isNotesPhaseDeleted(current) ||
        (exactDeletionId && current.deletion?.currentDeletionId !== exactDeletionId)
      ) {
        throw new Error("This phase has changed. Close this dialog and review its current state.");
      }
      const visible = snapshot.document.phases.filter(
        (p) => !isNotesPhaseDeleted(p) && (p.archivedAt !== null) === (current.archivedAt !== null),
      );
      const index = visible.findIndex((p) => p.id === phase.id);
      focusCandidates.current = [
        ...visible.slice(index + 1),
        ...visible.slice(0, index).reverse(),
      ].map((p) => p.id);
      setTarget({ phase: current, action });
      setRequest({
        version: 1,
        action,
        operationId: crypto.randomUUID(),
        phaseId: phase.id,
        expectedProjectKey: snapshot.projectKey,
        expectedRevision: snapshot.revision,
        expectedGeneration: notesPhaseDeletionGeneration(current),
      });
    } catch (cause) {
      if (generation === epoch.current)
        setError(cause instanceof Error ? cause.message : "Unable to prepare this action.");
    } finally {
      if (generation === epoch.current) setPreparing(false);
    }
  };
  const close = () => {
    if (dispatched.current) return;
    epoch.current++;
    setTarget(null);
    setRequest(null);
    setError(null);
    requestAnimationFrame(() => invoker.current?.isConnected && invoker.current.focus());
  };
  const confirm = async () => {
    if (!target || !request || !bridge || dispatched.current) return;
    const generation = epoch.current;
    dispatched.current = true;
    setPending(true);
    setError(null);
    try {
      const outcome = await bridge.mutate(request);
      if (generation !== epoch.current) return;
      if (outcome.status === "committed") {
        setTarget(null);
        setRequest(null);
        setUncertain(false);
        // The acknowledged operation may be a replay of an older cycle: keep its identity
        // separate from whatever deletion the current snapshot holds.
        const current = outcome.snapshot.document.phases.find((p) => p.id === request.phaseId);
        const currentDeletionId =
          current && isNotesPhaseDeleted(current) ? current.deletion!.currentDeletionId : null;
        const acknowledged =
          outcome.operationId === request.operationId && outcome.action === request.action
            ? outcome.operationId
            : null;
        const title = target.phase.title;
        let deletionId: string | null = null;
        let message: string;
        if (outcome.action === "recover") {
          message =
            currentDeletionId === null
              ? `Recovered “${title}”. Past runs and reminders were not resumed.`
              : `The earlier recovery was saved. “${title}” has since been deleted again — recover it from Deleted phases.`;
        } else if (acknowledged !== null && currentDeletionId === acknowledged) {
          deletionId = acknowledged;
          message = `Deleted “${title}”. You can recover it from Deleted phases.`;
        } else if (currentDeletionId === null) {
          message = `The earlier deletion was saved. “${title}” has since been recovered.`;
        } else {
          message = `The earlier deletion was saved. “${title}” has since been deleted again — recover that deletion from Deleted phases.`;
        }
        setSuccess({ phase: target.phase, deletionId, message });
        if (outcome.action === "delete" && currentDeletionId !== null)
          onDeleteCommitted?.(request.phaseId);
        requestAnimationFrame(() => {
          const titles = Array.from(
            document.querySelectorAll<HTMLElement>("[data-phase-focus]"),
          ).filter((element) => !element.closest("[hidden], [inert]"));
          const candidate = focusCandidates.current
            .map((id) => titles.find((element) => element.dataset.phaseFocus === id))
            .find(Boolean);
          const fallback = Array.from(
            document.querySelectorAll<HTMLElement>("[data-phase-focus-fallback]"),
          ).find((element) => !element.closest("[hidden], [inert]"));
          (candidate ?? fallback)?.focus();
        });
      } else if (outcome.status === "conflict") {
        setRequest(null);
        setUncertain(false);
        setError(
          "Project Notes changed in another window. Review the latest phase and confirm again.",
        );
      } else {
        setUncertain(outcome.status === "uncertain");
        setError(
          outcome.status === "missing"
            ? "This phase is unavailable. Refresh Project Notes."
            : outcome.message,
        );
      }
    } catch {
      if (generation === epoch.current) {
        setUncertain(true);
        setError(
          "The write outcome is unknown. Reconnect and retry this same request to check what was saved.",
        );
      }
    } finally {
      if (generation === epoch.current) {
        dispatched.current = false;
        setPending(false);
      }
    }
  };
  return {
    target,
    request,
    pending,
    preparing,
    error,
    uncertain,
    success,
    begin,
    close,
    confirm,
    clearSuccess: () => setSuccess(null),
    undo: () => success?.deletionId && begin(success.phase, "recover", success.deletionId),
  };
}
export type PhaseDeletionController = ReturnType<typeof usePhaseDeletion>;
