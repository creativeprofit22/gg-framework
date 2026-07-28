// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNotes, type ProjectNotesPromptActions } from "./ProjectNotes";
import {
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "./notes-reference";
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
  NotesReference,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "./notes-types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

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

function reference(
  id: string,
  owner = "owner",
  repo = "repo",
  path = "src/file.ts",
): NotesReference {
  return {
    id,
    provider: "github",
    tool: "search",
    canonicalUrl: `https://github.com/${owner}/${repo}/blob/main/${path}#L1-L2`,
    owner,
    repo,
    revision: "main",
    path,
    range: { startLine: 1, endLine: 2 },
    issue: null,
    pullRequest: null,
    query: "reference query",
    anchor: "L1-L2",
    relevance: `Evidence from ${owner}/${repo}`,
    capturedAt: NOW,
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
  beforeNextSave: (() => void) | null = null;
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
    const beforeSave = this.beforeNextSave;
    this.beforeNextSave = null;
    beforeSave?.();
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
  vi.clearAllMocks();
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

  it("shows attached scope before Start, locks competing controls while pending, and closes on success", async () => {
    const cwd = "/work/phase-start";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("free-form notes must stay out of the phase package");
    const attached = reference("ref-start");
    populated.references = [attached];
    populated.phases = [
      {
        ...phase("start", "not-started"),
        title: "Start contract",
        referenceIds: [attached.id],
        sourcePrompt: "Saved phase-only prompt",
      },
    ];
    client.seed(cwd, populated);
    let resolveStart!: (result: {
      status: "accepted";
      operationId: string;
      session: { sessionId: string; sessionPath: string };
      packageTokenCount: number;
    }) => void;
    const onStartPhase = vi.fn(
      () =>
        new Promise<{
          status: "accepted";
          operationId: string;
          session: { sessionId: string; sessionPath: string };
          packageTokenCount: number;
        }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Start contract" }));
    expect(onStartPhase).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Attached references" })).toBeTruthy();
    expect(screen.getAllByText("Evidence from owner/repo").length).toBeGreaterThan(0);
    expect(screen.getByText("Saved phase-only prompt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start phase" }));
    expect(onStartPhase).toHaveBeenCalledExactlyOnceWith("start");
    expect((screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Status override") as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Archive phase" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      resolveStart({
        status: "accepted",
        operationId: "operation-1",
        session: { sessionId: "session-1", sessionPath: "/session-1.jsonl" },
        packageTokenCount: 120,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disables Start and Recover when coding mode is unavailable and keeps Resume available", async () => {
    const cwd = "/work/phase-mode-gate";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    const bound = { sessionId: "bound", sessionPath: "/bound.jsonl" };
    const recoverable = { sessionId: "recoverable", sessionPath: null };
    populated.phases = [
      { ...phase("start", "not-started"), title: "Start in code", order: 0 },
      {
        ...phase("recover", "needs-attention"),
        title: "Recover in code",
        order: 1,
        session: recoverable,
      },
      { ...phase("resume", "planning"), title: "Resume in code", order: 2, session: bound },
    ];
    client.seed(cwd, populated);
    const onStartPhase = vi.fn();
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={onResumePhase}
        phaseStartUnavailableReason="Switch to coding mode to start this phase."
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Start in code" }));
    const start = screen.getByRole("button", { name: "Start phase" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Switch to coding mode to start this phase.");
    expect(screen.getByText("Switch to coding mode to start this phase.")).toBeTruthy();
    fireEvent.click(start);
    expect(onStartPhase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Recover phase: Recover in code" }));
    const recover = screen.getByRole("button", { name: "Recover phase" }) as HTMLButtonElement;
    expect(recover.disabled).toBe(true);
    expect(recover.title).toBe("Switch to coding mode to start this phase.");
    fireEvent.click(recover);
    expect(onResumePhase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume phase: Resume in code" }));
    const resume = screen.getByRole("button", { name: "Resume phase" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith("resume", bound));
  });

  it("announces retryable failure, returns focus, and turns an already-bound race into Resume", async () => {
    const cwd = "/work/phase-recovery";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      {
        ...phase("recover", "needs-attention"),
        title: "Recover phase",
        attentionReason: "Previous prompt failed.",
      },
    ];
    client.seed(cwd, populated);
    const bound = { sessionId: "winner", sessionPath: "/winner.jsonl" };
    const onStartPhase = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        code: "launch-failed",
        operationId: "operation-1",
        message: "Could not create the phase session. Retry.",
      })
      .mockResolvedValueOnce({
        status: "already-bound",
        operationId: "operation-2",
        session: bound,
        packageTokenCount: 0,
      });
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={onResumePhase}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Recover phase" }));
    expect(screen.getByText("Needs attention: Previous prompt failed.")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start phase" });
    fireEvent.click(start);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not create the phase session. Retry.",
    );
    expect(screen.queryByText("Starting phase…")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(start));

    fireEvent.click(start);
    expect((await screen.findByRole("alert")).textContent).toContain("started in another window");
    expect(screen.queryByText("Starting phase…")).toBeNull();
    const resume = screen.getByRole("button", { name: "Resume phase" });
    fireEvent.click(resume);
    await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith("recover", bound));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["not-started", "Not started"],
    ["needs-attention", "Needs attention"],
    ["cancelled", "Cancelled"],
  ] as const)(
    "routes a %s phase with a null-path binding through recovery",
    async (status, statusLabel) => {
      const cwd = `/work/null-path-${status}`;
      const client = new FakeProjectNotesClient(cwd);
      const populated = notes("reference");
      const link = { sessionId: "bound", sessionPath: null };
      populated.phases = [
        {
          ...phase(status, status),
          title: `${statusLabel} recovery`,
          session: link,
          attentionReason:
            status === "needs-attention" ? "The previous session lost its path." : null,
        },
      ];
      client.seed(cwd, populated);
      const onResumePhase = vi.fn().mockResolvedValue(undefined);
      render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Roadmap");
      fireEvent.click(
        screen.getByRole("button", { name: `Recover phase: ${statusLabel} recovery` }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Recover phase" }));

      await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith(status, link));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  it("saves an exact prompt through the imperative handle and renders it in phase detail", async () => {
    const cwd = "/work/saved-prompt";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("target", "in-progress"), sourcePrompt: "" }];
    client.seed(cwd, populated);
    const actions = createRef<ProjectNotesPromptActions>();
    render(<ProjectNotes ref={actions} cwd={cwd} client={client} />);

    await waitFor(() => expect(actions.current?.listDestinations()).toHaveLength(1));
    expect(actions.current?.listDestinations()).toEqual([
      { phaseId: "target", title: "Phase target", sourcePrompt: "" },
    ]);

    const prompt = "Exact saved prompt\n  with indentation and symbols <>&";
    await act(async () => {
      await expect(
        actions.current!.savePrompt({
          kind: "existing-phase",
          phaseId: "target",
          prompt,
          expectedSourcePrompt: "",
        }),
      ).resolves.toEqual({ status: "committed", phaseId: "target", title: "Phase target" });
    });
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.sourcePrompt).toBe(
      prompt,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Phase target" }));
    const heading = screen.getByRole("heading", { name: "Saved prompt" });
    expect(heading).toBeTruthy();
    expect(heading.nextElementSibling?.textContent).toBe(prompt);
  });

  it("renders authoritative lifecycle labels and recovery actions without losing selection", async () => {
    const cwd = "/work/roadmap-lifecycle";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    const bound = { sessionId: "bound", sessionPath: "/bound.jsonl" };
    populated.phases = [
      { ...phase("not-started", "not-started"), title: "Not started phase", order: 0 },
      { ...phase("planning", "planning"), title: "Planning phase", order: 1 },
      {
        ...phase("waiting", "waiting-for-approval"),
        title: "Waiting phase",
        order: 2,
        session: bound,
      },
      { ...phase("progress", "in-progress"), title: "Progress phase", order: 3, session: bound },
      { ...phase("review", "review"), title: "Review phase", order: 4, session: bound },
      { ...phase("done", "done"), title: "Done phase", order: 5, session: bound },
      {
        ...phase("attention", "needs-attention"),
        title: "Attention phase",
        order: 6,
        attentionReason:
          "The provider failed while validating a very long localized implementation result that still needs recovery.",
      },
      {
        ...phase("attention-bound", "needs-attention"),
        title: "Bound attention phase",
        order: 7,
        session: bound,
        attentionReason: "Resume the bound phase.",
      },
      {
        ...phase("cancelled", "cancelled"),
        title: "Cancelled phase",
        order: 8,
        session: bound,
      },
      {
        ...phase("manual-cancelled", "cancelled"),
        title: "Manual cancellation",
        order: 9,
        session: bound,
        overrides: {
          status: { value: "cancelled", source: "user", updatedAt: NOW },
          referenceIds: null,
        },
      },
    ];
    client.seed(cwd, populated);
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    const expectedRows = [
      ["Not started phase", "Not started", "Start"],
      ["Planning phase", "Planning", "Resume"],
      ["Waiting phase", "Waiting for approval", "Resume"],
      ["Progress phase", "In progress", "Resume"],
      ["Review phase", "Review", "Review"],
      ["Done phase", "Done", "Review"],
      ["Attention phase", "Needs attention", "Start"],
      ["Bound attention phase", "Needs attention", "Resume"],
      ["Cancelled phase", "Cancelled", "Resume"],
      ["Manual cancellation", "Cancelled", "Review"],
    ] as const;
    for (const [title, label, action] of expectedRows) {
      const button = screen.getByRole("button", { name: `${action} phase: ${title}` });
      expect(button.closest("li")?.textContent).toContain(label);
    }

    fireEvent.click(screen.getByRole("button", { name: "Start phase: Attention phase" }));
    expect(screen.getByText(/Needs attention: The provider failed/)).toBeTruthy();
    const statusSelect = screen.getByLabelText("Status override");
    const helpId = statusSelect.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId!)?.textContent).toBe(
      "Choosing a status pauses automatic lifecycle updates for this phase.",
    );

    const refreshed = structuredClone(populated);
    refreshed.phases[6] = {
      ...refreshed.phases[6]!,
      status: "in-progress",
      session: bound,
      attentionReason: "Stale reason must stay hidden.",
      updatedAt: "2026-07-15T12:01:00.000Z",
    };
    act(() => client.publish(cwd, refreshed, 2));
    expect(await screen.findByRole("heading", { name: "Attention phase" })).toBeTruthy();
    expect(screen.queryByText(/Stale reason must stay hidden/)).toBeNull();
    expect(screen.getByRole("button", { name: "Resume phase" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Manual cancellation" }));
    const overriddenSelect = screen.getByLabelText("Status override");
    const overriddenHelpId = overriddenSelect.getAttribute("aria-describedby");
    expect(document.getElementById(overriddenHelpId!)?.textContent).toBe(
      "Automatic lifecycle updates are paused because a manual status override is active.",
    );
    expect(screen.queryByRole("button", { name: "Resume phase" })).toBeNull();
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

  it("creates, validates, inspects, opens, edits, unlinks, and deletes one shared reference", async () => {
    const cwd = "/work/reference-crud";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("Free-form reference stays here");
    populated.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, populated);
    const openSource = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    render(<ProjectNotes cwd={cwd} client={client} openSource={openSource} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "Free-form reference stays here",
    );
    expect(screen.getByText("No structured references yet")).toBeTruthy();
    expect(openSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New reference" }));
    expect((screen.getByLabelText("Canonical URL (required)") as HTMLInputElement).maxLength).toBe(
      NOTES_REFERENCE_URL_MAX_LENGTH,
    );
    for (const label of [
      "Provider (required)",
      "Tool",
      "Repository owner (required)",
      "Repository name (required)",
      "Relevance note",
      "Revision",
      "Path",
      "Query",
      "Anchor",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).maxLength).toBe(
        NOTES_REFERENCE_METADATA_MAX_LENGTH,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));
    expect(await screen.findByText(/Fix 3 fields/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Canonical URL (required)"));

    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: " github-search " } });
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: "HTTPS://GITHUB.COM:443/Owner/Repo/pull/44/" },
    });
    fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
      target: { value: " Owner " },
    });
    fireEvent.change(screen.getByLabelText("Repository name (required)"), {
      target: { value: " Repo " },
    });
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: " Reviews the structured reference boundary " },
    });
    fireEvent.change(screen.getByLabelText("Revision"), { target: { value: " main " } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: " src/file.ts " } });
    fireEvent.change(screen.getByLabelText("Start line"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("End line"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "44" } });
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: " schema " } });
    fireEvent.change(screen.getByLabelText("Anchor"), { target: { value: " discussion_r44 " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Phase alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

    const inspect = await screen.findByRole("button", {
      name: "Inspect reference: Pull request #44 in Owner/Repo",
    });
    expect(openSource).not.toHaveBeenCalled();
    fireEvent.click(inspect);
    expect(screen.getByText("https://github.com/Owner/Repo/pull/44")).toBeTruthy();
    expect(screen.getAllByText("Reviews the structured reference boundary")).toHaveLength(2);
    expect(screen.getByText("10 to 20")).toBeTruthy();
    expect(openSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    await waitFor(() =>
      expect(openSource).toHaveBeenCalledExactlyOnceWith("https://github.com/Owner/Repo/pull/44"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: "Updated relevance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findAllByText("Updated relevance")).toHaveLength(2);
    const storedAfterEdit = client.snapshots.get(canonicalProjectKey(cwd))!.document;
    expect(storedAfterEdit.references[0]).toMatchObject({
      id: expect.any(String),
      capturedAt: expect.any(String),
      owner: "Owner",
      repo: "Repo",
      revision: "main",
      path: "src/file.ts",
      range: { startLine: 10, endLine: 20 },
      pullRequest: 44,
      query: "schema",
      anchor: "discussion_r44",
      relevance: "Updated relevance",
    });
    expect(storedAfterEdit.phases[0]?.overrides.referenceIds).toMatchObject({ source: "user" });
    expect(
      screen.getByText(/Unlink this reference from Phase alpha before deleting it/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Phase alpha/ }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.referenceIds,
      ).toEqual([]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete reference" }));
    expect(screen.getByRole("group", { name: "Confirm delete reference" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toEqual([]),
    );
    expect(screen.getByText("No structured references yet")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New reference" }));
  });

  it.each([
    ["username", "https://user@github.com/owner/repo"],
    ["password", "https://:secret@github.com/owner/repo"],
  ])(
    "rejects a reference URL containing a %s before component persistence",
    async (_credential, url) => {
      const cwd = "/work/reference-credentials";
      const client = new FakeProjectNotesClient(cwd);
      client.seed(cwd, notes("reference"));
      render(<ProjectNotes cwd={cwd} client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Reference");
      fireEvent.click(screen.getByRole("button", { name: "New reference" }));
      fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
        target: { value: url },
      });
      fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
        target: { value: "owner" },
      });
      fireEvent.change(screen.getByLabelText("Repository name (required)"), {
        target: { value: "repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

      expect(
        await screen.findByText(
          "Enter an absolute HTTP or HTTPS URL without a username or password.",
        ),
      ).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText("Canonical URL (required)"));
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.references).toEqual([]);
    },
  );

  it("blocks a credential-bearing stored reference before invoking the system opener", async () => {
    const cwd = "/work/reference-open-credentials";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.references = [
      {
        ...reference("ref-credential"),
        canonicalUrl: "https://user:secret@github.com/owner/repo/blob/main/src/file.ts#L1-L2",
      },
    ];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t open this source in the system browser. Try again.",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reuses a duplicate, preserves selection snapshots, and surfaces opener failure", async () => {
    const cwd = "/work/reference-duplicate";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.references = [reference("ref-existing")];
    client.seed(cwd, populated);
    const openSource = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValue(new Error("blocked"));
    render(<ProjectNotes cwd={cwd} client={client} openSource={openSource} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    expect(openSource).not.toHaveBeenCalled();

    const refreshed = {
      ...populated,
      references: [{ ...populated.references[0]!, relevance: "Refreshed stored metadata" }],
    };
    act(() => client.publish(cwd, refreshed, 2));
    expect(await screen.findAllByText("Refreshed stored metadata")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open source" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t open this source in the system browser. Try again.",
    );
    expect(openSource).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to references" }));
    fireEvent.click(screen.getByRole("button", { name: "New reference" }));
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: "https://github.com/owner/repo/blob/main/src/file.ts#L1-L2" },
    });
    fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Repository name (required)"), {
      target: { value: "repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

    expect(await screen.findByText(/Already saved: src\/file.ts:L1-L2/)).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open source" })).toBeTruthy();

    const removed = {
      ...client.snapshots.get(canonicalProjectKey(cwd))!.document,
      references: [],
    };
    act(() => client.publish(cwd, removed, 3));
    expect(await screen.findByText("No structured references yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open source" })).toBeNull();
  });

  it("keeps a stale edit open and reports a canonical collision after conflict replay", async () => {
    const cwd = "/work/reference-edit-collision";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-edited")];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const winner = reference("ref-winner", "owner", "repo", "src/winner.ts");
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: winner.canonicalUrl },
    });
    client.beforeNextSave = () => {
      const authoritative = { ...initial, references: [initial.references[0]!, winner] };
      client.seed(cwd, authoritative, 2);
    };
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/Couldn’t save: another reference now uses these source coordinates/),
    ).toBeTruthy();
    expect(screen.queryByText(/Updated reference:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect((screen.getByLabelText("Canonical URL (required)") as HTMLInputElement).value).toBe(
      winner.canonicalUrl,
    );
    expect(
      client.snapshots
        .get(canonicalProjectKey(cwd))!
        .document.references.find((item) => item.id === "ref-edited")?.canonicalUrl,
    ).toBe(initial.references[0]!.canonicalUrl);
  });

  it("restores a delete selection when a concurrent phase link blocks replay", async () => {
    const cwd = "/work/reference-delete-linked";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-delete")];
    initial.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete reference" }));
    client.beforeNextSave = () => {
      const authoritative = {
        ...initial,
        phases: [{ ...initial.phases[0]!, referenceIds: ["ref-delete"] }],
      };
      client.seed(cwd, authoritative, 2);
    };
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(
      await screen.findByText(/Couldn’t delete: this reference was attached to a phase/),
    ).toBeTruthy();
    expect(screen.queryByText(/Deleted reference:/)).toBeNull();
    expect(screen.getByRole("heading", { name: "src/file.ts:L1-L2" })).toBeTruthy();
    expect(
      screen.getByText(/Unlink this reference from Phase alpha before deleting it/),
    ).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toHaveLength(1);
  });

  it("reports a phase that disappears while a roadmap attachment rebases", async () => {
    const cwd = "/work/reference-link-missing-phase";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-link")];
    initial.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Phase alpha" }));
    client.beforeNextSave = () => client.seed(cwd, { ...initial, phases: [] }, 2);
    fireEvent.click(screen.getByRole("checkbox", { name: /Evidence from owner\/repo/ }));

    expect(
      await screen.findByText("Couldn’t attach: the phase was removed in another window."),
    ).toBeTruthy();
    expect(screen.queryByText(/Attached src\/file.ts:L1-L2 to Phase alpha/)).toBeNull();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases).toEqual([]);
  });

  it("reports a reference that disappears while an unlink rebases", async () => {
    const cwd = "/work/reference-unlink-missing-reference";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-unlink")];
    initial.phases = [
      { ...phase("alpha", "in-progress"), title: "Phase alpha", referenceIds: ["ref-unlink"] },
    ];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    client.beforeNextSave = () => {
      client.seed(
        cwd,
        {
          ...initial,
          references: [],
          phases: [{ ...initial.phases[0]!, referenceIds: [] }],
        },
        2,
      );
    };
    fireEvent.click(screen.getByRole("checkbox", { name: /Phase alpha/ }));

    expect(
      await screen.findByText("Couldn’t detach: the reference was removed in another window."),
    ).toBeTruthy();
    expect(screen.queryByText(/Detached reference from Phase alpha/)).toBeNull();
    expect(await screen.findByText("No structured references yet")).toBeTruthy();
  });

  it("keeps a reference edit open when the backend rejects the save", async () => {
    const cwd = "/work/reference-invalid-save";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-invalid")];
    client.seed(cwd, initial);
    client.saveOutcome = {
      status: "invalid",
      error: { path: "references[0].canonicalUrl", message: "invalid fixture" },
    };
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: "Unsaved invalid edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/Couldn’t save: Project Notes rejected the change/),
    ).toBeTruthy();
    expect(screen.queryByText(/Updated reference:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect((screen.getByLabelText("Relevance note") as HTMLTextAreaElement).value).toBe(
      "Unsaved invalid edit",
    );
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references[0]!.relevance).toBe(
      "Evidence from owner/repo",
    );
    expect((await screen.findByLabelText("Notes storage status")).textContent).toContain(
      "Changes aren’t saved",
    );
  });

  it("opens reference creation from empty phase detail and renders fifty grouped rows", async () => {
    const cwd = "/work/reference-density";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("empty", "not-started"), title: "Empty context phase" }];
    populated.references = Array.from({ length: 50 }, (_, index) =>
      reference(
        `ref-${index}`,
        index % 2 === 0 ? "alpha" : "beta",
        index % 2 === 0 ? "frontend" : "sidecar",
        `src/long/path/reference-${String(index).padStart(2, "0")}.ts`,
      ),
    );
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Empty context phase" }));
    expect(screen.getByRole("heading", { name: "Attached references" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /Evidence from/ })).toHaveLength(50);

    selectNotesTab("Reference");
    expect(screen.getByText("50 references")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /alpha\/frontend/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /beta\/sidecar/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Inspect reference:/ })).toHaveLength(50);
    expect(document.querySelectorAll(".notes-reference-row button button")).toHaveLength(0);

    const empty = { ...populated, references: [] };
    act(() => client.publish(cwd, empty, 2));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Empty context phase" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a reference" }));
    expect(screen.getByRole("tab", { name: "Reference" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByRole("heading", { name: "New structured reference" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Provider (required)")),
    );
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
