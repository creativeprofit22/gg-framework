// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyNotesPhaseDeletion, type NotesPhase, type PhaseDeletionOutcome, type ProjectNotesSnapshot } from "@kenkaiiii/gg-core/project-notes";
import { createEmptyNotesDocument } from "../notes-storage";
import { usePhaseDeletion, type PhaseDeletionBridge } from "./usePhaseDeletion";
import { NotesPhaseDeletionDialog } from "./NotesPhaseDeletionDialog";
import { NotesDeletedPhases } from "./NotesDeletedPhases";
import { Modal } from "../Modal";

const now = "2026-09-21T12:00:00.000Z";
const phase: NotesPhase = { id: "phase", title: "A very long phase title ".repeat(8), goal: "Preserve data", doneWhen: [],
  order: 0, status: "not-started", sourcePrompt: "", referenceIds: [], session: null, reminder: null,
  attentionReason: null, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null,
  overrides: { status: null, referenceIds: null }, pendingAutomaticLifecycleTransition: null, lifecycleEvents: [], roadmapEvents: [] };
const snapshot = (): ProjectNotesSnapshot => ({ projectKey: "synthetic", revision: 1,
  document: { ...createEmptyNotesDocument(now), phases: [structuredClone(phase)] } });
function fixture() {
  let current = snapshot();
  const bridge: PhaseDeletionBridge = { prepare: vi.fn(async () => current), mutate: vi.fn(async (request): Promise<PhaseDeletionOutcome> => {
    current = { ...current, revision: current.revision + 1,
      document: { ...current.document, phases: [applyNotesPhaseDeletion(current.document.phases[0]!, request, now)] } };
    return { status: "committed", action: request.action, operationId: request.operationId, replayed: false, snapshot: current };
  }) };
  return { bridge, current: () => current };
}
afterEach(cleanup);

describe("phase deletion controller", () => {
  it("confirms only after preparation; Cancel never dispatches", async () => {
    const f = fixture(); const hook = renderHook(() => usePhaseDeletion("synthetic", f.bridge));
    await act(async () => { await hook.result.current.begin(phase, "delete"); });
    expect(hook.result.current.request?.expectedRevision).toBe(1);
    act(() => hook.result.current.close());
    expect(f.bridge.mutate).not.toHaveBeenCalled(); expect(hook.result.current.target).toBeNull();
  });

  it("keeps exact request identity through uncertain retry and supports durable Undo", async () => {
    const f = fixture(); const mutate = vi.mocked(f.bridge.mutate);
    mutate.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const hook = renderHook(() => usePhaseDeletion("synthetic", f.bridge));
    await act(async () => { await hook.result.current.begin(phase, "delete"); });
    const input = hook.result.current.request;
    await act(async () => { await hook.result.current.confirm(); });
    expect(hook.result.current.uncertain).toBe(true); expect(hook.result.current.request).toBe(input);
    await act(async () => { await hook.result.current.confirm(); });
    expect(mutate.mock.calls[0]![0]).toBe(mutate.mock.calls[1]![0]);
    expect(hook.result.current.success?.deletionId).toBe(input!.operationId);
    await act(async () => { await hook.result.current.undo(); });
    expect(hook.result.current.request?.action).toBe("recover");
    await act(async () => { await hook.result.current.confirm(); });
    expect(f.current().document.phases[0]!.deletion?.currentDeletionId).toBeNull();
    expect(hook.result.current.success?.message).toContain("Past runs and reminders were not resumed");
  });

  it("never rebases a stale destructive request without renewed confirmation", async () => {
    const f = fixture(); vi.mocked(f.bridge.mutate).mockResolvedValueOnce({ status: "conflict", snapshot: { ...snapshot(), revision: 2 } });
    const hook = renderHook(() => usePhaseDeletion("synthetic", f.bridge));
    await act(async () => { await hook.result.current.begin(phase, "delete"); await hook.result.current.confirm(); });
    // The confirmation uses the request from the next render.
    await act(async () => { await hook.result.current.confirm(); });
    expect(hook.result.current.request).toBeNull(); expect(hook.result.current.error).toContain("confirm again");
    await act(async () => { await hook.result.current.confirm(); });
    expect(f.bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it("prevents double dispatch and ignores a late reply after switching projects", async () => {
    const f = fixture(); let finish!: (value: PhaseDeletionOutcome) => void;
    vi.mocked(f.bridge.mutate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(({ project }) => usePhaseDeletion(project, f.bridge), { initialProps: { project: "synthetic" } });
    await act(async () => { await hook.result.current.begin(phase, "delete"); });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.confirm(); void hook.result.current.confirm(); hook.result.current.close(); });
    expect(hook.result.current.pending).toBe(true); expect(hook.result.current.target).not.toBeNull();
    expect(f.bridge.mutate).toHaveBeenCalledTimes(1);
    hook.rerender({ project: "other" });
    await act(async () => { finish({ status: "committed", action: "delete", operationId: "old", replayed: false, snapshot: snapshot() }); await pending; });
    expect(hook.result.current.success).toBeNull(); expect(hook.result.current.target).toBeNull();
  });

  it("preserves context after failed saves and refuses Undo for a different deletion", async () => {
    const f = fixture(); vi.mocked(f.bridge.prepare).mockRejectedValueOnce(new Error("Unsaved edits"));
    const hook = renderHook(() => usePhaseDeletion("synthetic", f.bridge));
    await act(async () => { await hook.result.current.begin(phase, "delete"); });
    expect(hook.result.current.error).toBe("Unsaved edits"); expect(hook.result.current.target?.phase.id).toBe(phase.id);
    expect(f.bridge.mutate).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.begin(phase, "recover", "different-deletion"); });
    expect(hook.result.current.request).toBeNull();
  });
});

it("uses Cancel-first focus and Escape closes only the nested confirmation", async () => {
  const f = fixture(); const outerClose = vi.fn();
  function Harness() {
    const controller = usePhaseDeletion("synthetic", f.bridge);
    return <Modal title="Notes" onClose={outerClose}><button onClick={() => void controller.begin(phase, "delete")}>Delete fixture</button><NotesPhaseDeletionDialog controller={controller} /></Modal>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByText("Delete fixture"));
  await waitFor(() => expect(screen.getByText("Delete phase")).toBeTruthy());
  expect(document.activeElement).toBe(screen.getByText("Cancel"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(outerClose).not.toHaveBeenCalled(); expect(screen.queryByText("Delete phase")).toBeNull();
  expect(f.bridge.mutate).not.toHaveBeenCalled();
});

it("shows retained deletion date, placement and recovery after remount", () => {
  const request = { version: 1 as const, action: "delete" as const, operationId: "retained", phaseId: phase.id,
    expectedProjectKey: "synthetic", expectedRevision: 1, expectedGeneration: 0 };
  const deleted = applyNotesPhaseDeletion(phase, request, now); const onRecover = vi.fn();
  render(<NotesDeletedPhases phases={[deleted]} onRecover={onRecover} />);
  fireEvent.click(screen.getByText("Deleted phases (1)"));
  expect(screen.getByText(/Originally active/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Recover phase: ${phase.title.trim()}` }));
  expect(onRecover).toHaveBeenCalledWith(deleted);
});
