// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectNotes } from "./ProjectNotes";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  legacyNotesKey,
  v3NotesKey,
} from "./notes-storage";
import type {
  NotesClient,
  NotesDocumentV3,
  NotesPhase,
  NotesPhaseStatus,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "./notes-types";
const NOW = "2026-07-15T12:00:00.000Z";

function notes(reference: string, taskCount = 0): NotesDocumentV3 {
  return {
    ...createEmptyNotesDocument(NOW),
    reference,
    currentFocus: `Focus ${reference}`,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      text: `Task ${index + 1}`,
      status: "todo" as const,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      archivedAt: null,
    })),
  };
}

function phase(id: string, status: NotesPhaseStatus, withReminder = false): NotesPhase {
  return {
    id,
    title: `Phase ${id}`,
    goal: "Verify the Notes shell",
    doneWhen: ["Shell evidence passes"],
    order: 0,
    status,
    sourcePrompt: "Implement Phase 17",
    referenceIds: [],
    session: null,
    reminder: withReminder
      ? { id: `reminder-${id}`, dueAt: NOW, note: "Review", createdAt: NOW }
      : null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" || status === "cancelled" ? NOW : null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    lifecycleEvents: [],
  };
}

function store(cwd: string, document: NotesDocumentV3): void {
  localStorage.setItem(v3NotesKey(cwd), JSON.stringify(document));
  localStorage.setItem(legacyNotesKey(cwd), document.reference);
}

function selectNotesTab(name: "Overview" | "Roadmap" | "Reference" | "Archive"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

class FakeProjectNotesClient implements NotesClient {
  cwd: string;
  readonly snapshots = new Map<string, ProjectNotesSnapshot>();
  readonly listeners = new Set<(event: NotesSidecarEvent) => void>();
  migrations = 0;
  getOutcome: ProjectNotesReadOutcome | null = null;
  migrationError: unknown = null;
  saveOutcome: ProjectNotesSaveOutcome | null = null;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  seed(cwd: string, document: NotesDocumentV3, revision = 1): void {
    const projectKey = canonicalProjectKey(cwd);
    this.snapshots.set(projectKey, { projectKey, revision, document });
  }

  async getNotes(): Promise<ProjectNotesReadOutcome> {
    if (this.getOutcome) return this.getOutcome;
    const snapshot = this.snapshots.get(canonicalProjectKey(this.cwd));
    return snapshot
      ? { status: "ok", snapshot, recoveredFromBackup: false }
      : { status: "missing" };
  }

  async migrateNotes(document: NotesDocumentV3): Promise<ProjectNotesMigrationOutcome> {
    if (this.migrationError) throw this.migrationError;
    const projectKey = canonicalProjectKey(this.cwd);
    const existing = this.snapshots.get(projectKey);
    if (existing) return { status: "ok", snapshot: existing, migrated: false };
    const snapshot = { projectKey, revision: 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.migrations += 1;
    this.emit(snapshot);
    return { status: "ok", snapshot, migrated: true };
  }

  async saveNotes(
    expectedRevision: number,
    document: NotesDocumentV3,
  ): Promise<ProjectNotesSaveOutcome> {
    if (this.saveOutcome) return this.saveOutcome;
    const projectKey = canonicalProjectKey(this.cwd);
    const current = this.snapshots.get(projectKey);
    if (!current) return { status: "missing" };
    if (current.revision !== expectedRevision) {
      return { status: "conflict", snapshot: current };
    }
    const snapshot = { projectKey, revision: expectedRevision + 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(snapshot);
    return { status: "ok", snapshot };
  }

  subscribe(listener: (event: NotesSidecarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(cwd: string, document: NotesDocumentV3, revision: number): void {
    const projectKey = canonicalProjectKey(cwd);
    const snapshot = { projectKey, revision, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(snapshot);
  }

  private emit(snapshot: ProjectNotesSnapshot): void {
    for (const listener of this.listeners) listener({ type: "notes_change", data: snapshot });
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ProjectNotes", () => {
  it("renders four stable tabs with automatic keyboard navigation and one visible panel", async () => {
    const cwd = "/work/shell";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Roadmap",
      "Reference",
      "Archive",
    ]);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(4);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    const overview = screen.getByRole("tab", { name: "Overview" });
    const roadmap = screen.getByRole("tab", { name: "Roadmap" });
    const reference = screen.getByRole("tab", { name: "Reference" });
    const archive = screen.getByRole("tab", { name: "Archive" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("aria-controls")).toBe("notes-panel-overview");
    expect(overview).toBe(document.activeElement);
    expect(roadmap.tabIndex).toBe(-1);
    expect(screen.queryByLabelText("Roadmap summary")).toBeNull();

    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(archive.getAttribute("aria-selected")).toBe("true");
    expect(archive).toBe(document.activeElement);

    fireEvent.keyDown(archive, { key: "ArrowRight" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(overview, { key: "End" });
    expect(archive.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(archive, { key: "Home" });
    expect(overview.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(reference);
    expect(reference.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.click(roadmap);
    expect(screen.getByText("No roadmap phases yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New phase" }));
    fireEvent.change(screen.getByLabelText("Phase title"), { target: { value: "First phase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create phase" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.phases).toHaveLength(1),
    );
    expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(1);
    expect(screen.queryByText("Selected phase")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New phase" }));
  });

  it("keeps an incoming Handoff unread until Overview is visible", async () => {
    const cwd = "/work/hidden-handoff";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    const incoming = notes("reference");
    incoming.handoff = { text: "Continue from the new state", updatedAt: NOW, readAt: null };

    await act(async () => {
      client.publish(cwd, incoming, 2);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole("button", { name: "Notes, unread Handoff" })).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.handoff.readAt).toBeNull();

    selectNotesTab("Overview");
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))?.document.handoff.readAt,
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("keeps active counts while exposing compact actions for active and settled phases", async () => {
    const cwd = "/work/roadmap-counts";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      phase("planning", "planning", true),
      phase("review", "review"),
      phase("done", "done", true),
      phase("cancelled", "cancelled", true),
    ].map((item, order) => ({ ...item, order }));
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const summary = screen.getByLabelText("Roadmap summary");
    expect(summary.textContent).toContain("2 active phases");
    expect(summary.textContent).toContain("1 active reminder");
    expect(screen.getByRole("tab", { name: "Roadmap" }).textContent).toBe("Roadmap2");

    selectNotesTab("Roadmap");
    expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Resume phase: Phase planning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review phase: Phase review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review phase: Phase done" })).toBeTruthy();
    expect(screen.queryByText("Selected phase")).toBeNull();

    const singular = notes("updated reference");
    singular.phases = [phase("attention", "needs-attention")];
    act(() => client.publish(cwd, singular, 2));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(1),
    );
    expect(screen.getByRole("tab", { name: "Roadmap" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps one selected phase open across authoritative snapshots", async () => {
    const cwd = "/work/roadmap-selection";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("only", "done"), title: "Only phase" }];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    expect(screen.queryByText("Selected phase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Only phase" }));
    expect(screen.getByRole("heading", { name: "Only phase" })).toBeTruthy();

    const refreshed = {
      ...populated,
      phases: [{ ...populated.phases[0]!, title: "Only phase refreshed", updatedAt: NOW }],
    };
    act(() => client.publish(cwd, refreshed, 2));

    expect(await screen.findByRole("heading", { name: "Only phase refreshed" })).toBeTruthy();
    expect(screen.getByText("Selected phase")).toBeTruthy();
  });

  it("creates, edits, reorders, overrides, cancels, archives, and restores phases", async () => {
    const cwd = "/work/roadmap-crud";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      { ...phase("alpha", "not-started"), title: "Alpha", order: 0 },
      { ...phase("beta", "in-progress"), title: "Beta", order: 1 },
    ];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    expect(screen.getByRole("button", { name: "Start phase: Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume phase: Beta" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New phase" }));
    fireEvent.change(screen.getByLabelText("Phase title"), { target: { value: "Gamma" } });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Ship phase CRUD" } });
    fireEvent.change(screen.getByLabelText("Done when"), {
      target: { value: "Create persists\nArchive restores" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create phase" }));

    await waitFor(() => {
      const stored = client.snapshots.get(canonicalProjectKey(cwd))!.document.phases;
      expect(stored.map((item) => item.title)).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(stored.map((item) => item.order)).toEqual([0, 1, 2]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Alpha" }));
    expect(screen.getByText("Verify the Notes shell")).toBeTruthy();
    expect(screen.getByText("Shell evidence passes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit phase title"), {
      target: { value: "Alpha edited" },
    });
    fireEvent.change(screen.getByLabelText("Edit goal"), { target: { value: "Edited goal" } });
    fireEvent.change(screen.getByLabelText("Edit Done when"), {
      target: { value: "First check\nSecond check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]).toMatchObject({
        title: "Alpha edited",
        goal: "Edited goal",
        doneWhen: ["First check", "Second check"],
      }),
    );

    fireEvent.change(screen.getByLabelText("Status override"), { target: { value: "done" } });
    await waitFor(() => {
      const stored = client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!;
      expect(stored.status).toBe("done");
      expect(stored.completedAt).not.toBeNull();
      expect(stored.overrides.status).toMatchObject({ value: "done", source: "user" });
      expect(stored.lifecycleEvents[stored.lifecycleEvents.length - 1]).toMatchObject({
        fromStatus: "not-started",
        toStatus: "done",
        source: "user",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases.map((item) => item.title),
      ).toEqual(["Beta", "Alpha edited", "Gamma"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel phase" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.status).toBe(
        "cancelled",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive phase" }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.archivedAt,
      ).not.toBe(null),
    );
    expect(screen.queryByText("Selected phase")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Inspect phase: Alpha edited" }),
      ),
    );

    selectNotesTab("Archive");
    fireEvent.click(screen.getByRole("button", { name: "Restore phase: Beta" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.archivedAt).toBe(
        null,
      ),
    );
    selectNotesTab("Roadmap");
    expect(screen.queryByText("Selected phase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Beta" }));
    expect(screen.getByText("Selected phase")).toBeTruthy();
  });

  it("renders a stable accessible list for fifty phases", async () => {
    const cwd = "/work/roadmap-density";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = Array.from({ length: 50 }, (_, order) => ({
      ...phase(`density-${order}`, order % 3 === 0 ? "review" : "not-started"),
      title: `Phase ${String(order + 1).padStart(2, "0")} with a deliberately long title`,
      order,
    }));
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");

    const list = screen.getByRole("list", { name: "Roadmap phases" });
    expect(list.children).toHaveLength(50);
    expect(list.querySelectorAll(".notes-roadmap-row")).toHaveLength(50);
    expect(screen.getAllByRole("button", { name: /phase: Phase/ })).toHaveLength(100);
  });

  it("preserves tab, task draft, edit mode, and Archive disclosure through rerenders", async () => {
    const cwd = "/work/mounted-panels";
    const client = new FakeProjectNotesClient(cwd);
    const original = notes("initial reference", 1);
    client.seed(cwd, original, 1);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    fireEvent.change(screen.getByLabelText("Add a Notes task"), {
      target: { value: "Draft survives navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Edit task: Task 1"), {
      target: { value: "Uncommitted task edit" },
    });

    selectNotesTab("Archive");
    const archiveToggle = screen.getByRole("button", { name: "Show archived tasks (0)" });
    fireEvent.click(archiveToggle);
    expect(archiveToggle.getAttribute("aria-expanded")).toBe("true");
    selectNotesTab("Reference");

    const updated = { ...original, reference: "authoritative reference", updatedAt: NOW };
    act(() => client.publish(cwd, updated, 2));
    await waitFor(() =>
      expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
        "authoritative reference",
      ),
    );
    expect(screen.getByRole("tab", { name: "Reference" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    selectNotesTab("Archive");
    expect(
      screen.getByRole("button", { name: "Hide archived tasks (0)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    selectNotesTab("Overview");
    expect((screen.getByLabelText("Add a Notes task") as HTMLInputElement).value).toBe(
      "Draft survives navigation",
    );
    expect((screen.getByLabelText("Edit task: Task 1") as HTMLInputElement).value).toBe(
      "Uncommitted task edit",
    );
  });

  it("keeps create, edit, move, archive, and restore flows on the sidecar path", async () => {
    const cwd = "/work/task-actions";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference", 2));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 2 unfinished tasks" }));
    fireEvent.change(screen.getByLabelText("Add a Notes task"), {
      target: { value: "Task 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks).toHaveLength(3),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Edit task: Task 1"), {
      target: { value: "Edited task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks[0]?.text).toBe(
        "Edited task",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move task up: Task 2" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks[0]?.text).toBe(
        "Task 2",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive task: Edited task" }));
    await waitFor(() =>
      expect(
        client.snapshots
          .get(canonicalProjectKey(cwd))
          ?.document.tasks.find((task) => task.text === "Edited task")?.archivedAt,
      ).not.toBeNull(),
    );

    selectNotesTab("Archive");
    fireEvent.click(screen.getByRole("button", { name: "Show archived tasks (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore task: Edited task" }));
    await waitFor(() =>
      expect(
        client.snapshots
          .get(canonicalProjectKey(cwd))
          ?.document.tasks.find((task) => task.text === "Edited task")?.archivedAt,
      ).toBeNull(),
    );
  });
  it("renders sidecar state and saves edits without dual-writing browser storage", async () => {
    const cwd = "/work/project";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("sidecar reference", 2));
    store(cwd, notes("stale local"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 2 unfinished tasks" }));
    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Focus sidecar reference",
    );
    selectNotesTab("Reference");
    fireEvent.change(screen.getByLabelText("Reference notes"), {
      target: { value: "updated reference" },
    });

    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
        "updated reference",
      ),
    );
    expect(localStorage.getItem(legacyNotesKey(cwd))).toBe("stale local");
    expect(JSON.parse(localStorage.getItem(v3NotesKey(cwd))!).reference).toBe("stale local");
  });

  it("preserves focus, task lifecycle, and handoff behavior through sidecar saves", async () => {
    const cwd = "/work/structured";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference", 1));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    fireEvent.change(screen.getByLabelText("Current focus"), {
      target: { value: "Finish the port" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Handoff notes"), {
      target: { value: "Review the uncommitted diff" },
    });

    await waitFor(() => {
      const persisted = client.snapshots.get(canonicalProjectKey(cwd))!.document;
      expect(persisted.currentFocus).toBe("Finish the port");
      expect(persisted.tasks[0]).toMatchObject({ status: "done" });
      expect(persisted.handoff.text).toBe("Review the uncommitted diff");
    });
    expect(await screen.findByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("closes an open modal and loads only the newly selected project's sidecar Notes", async () => {
    const cwdA = "C:\\work\\a";
    const cwdB = "C:\\work\\b";
    const client = new FakeProjectNotesClient(cwdA);
    client.seed(cwdA, notes("project A"));
    client.seed(cwdB, notes("project B", 1));
    const view = render(<ProjectNotes cwd={cwdA} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project A",
    );

    client.cwd = cwdB;
    view.rerender(<ProjectNotes cwd={cwdB} client={client} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Focus project B",
    );
    selectNotesTab("Reference");

    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project B",
    );
  });

  it("migrates local content once and restores after localStorage is cleared", async () => {
    const cwd = "/work/migrate";
    const client = new FakeProjectNotesClient(cwd);
    store(cwd, notes("  migrated\r\nbytes 😀\n", 1));
    const first = render(<ProjectNotes cwd={cwd} client={client} />);

    expect(await screen.findByRole("button", { name: "Notes, 1 unfinished task" })).toBeTruthy();
    expect(client.migrations).toBe(1);
    first.unmount();
    localStorage.clear();

    render(<ProjectNotes cwd={cwd} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "  migrated\nbytes 😀\n",
    );
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
      "  migrated\r\nbytes 😀\n",
    );
    expect(client.migrations).toBe(1);
  });

  it("updates status and content from a newer sidecar event", async () => {
    const cwd = "C:\\Work\\Project";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("initial", 1), 1);
    render(<ProjectNotes cwd={cwd} client={client} />);
    expect(await screen.findByRole("button", { name: "Notes, 1 unfinished task" })).toBeTruthy();

    act(() => client.publish(cwd, notes("latest", 3), 2));

    const trigger = await screen.findByRole("button", { name: "Notes, 3 unfinished tasks" });
    fireEvent.click(trigger);
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe("latest");
  });

  it("surfaces corrupt project Notes while keeping the local fallback editable", async () => {
    const cwd = "/work/corrupt";
    const client = new FakeProjectNotesClient(cwd);
    client.getOutcome = {
      status: "corrupt",
      primary: "malformed-json",
      backup: "invalid-envelope",
    };
    store(cwd, notes("local recovery copy"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const storageStatus = await screen.findByLabelText("Notes storage status");
    expect(storageStatus.getAttribute("role")).toBe("alert");
    expect(storageStatus.textContent).toContain("Project Notes are unreadable");
    expect(storageStatus.textContent).toContain("local fallback");
    selectNotesTab("Reference");
    await waitFor(() =>
      expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
        "local recovery copy",
      ),
    );
  });

  it("explains migration failure and local fallback without leaking the raw error", async () => {
    const cwd = "/work/migration-failure";
    const client = new FakeProjectNotesClient(cwd);
    client.migrationError = new Error("C:\\Users\\private\\notes.json could not be written");
    store(cwd, notes("recoverable local notes"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const storageStatus = await screen.findByLabelText("Notes storage status");
    await waitFor(() =>
      expect(storageStatus.textContent).toContain("Couldn’t move Notes to project storage"),
    );
    expect(storageStatus.textContent).toContain("local fallback");
    expect(storageStatus.textContent).not.toContain("private");
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "recoverable local notes",
    );
  });

  it("shows a failed sidecar save while retaining the optimistic edit", async () => {
    const cwd = "/work/save-failure";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("saved reference"));
    client.saveOutcome = {
      status: "invalid",
      error: { path: "document", message: "invalid fixture" },
    };
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    const reference = screen.getByLabelText("Reference notes") as HTMLTextAreaElement;
    await waitFor(() => expect(reference.value).toBe("saved reference"));
    fireEvent.change(reference, { target: { value: "optimistic edit" } });

    const storageStatus = await screen.findByLabelText("Notes storage status");
    await waitFor(() => expect(storageStatus.textContent).toContain("Changes aren’t saved"));
    expect(storageStatus.getAttribute("role")).toBe("alert");
    expect(reference.value).toBe("optimistic edit");
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
      "saved reference",
    );
  });
});
