// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectNotes } from "./ProjectNotes";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  legacyNotesKey,
  v2NotesKey,
} from "./notes-storage";
import type {
  NotesClient,
  NotesDocumentV2,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "./notes-types";
const NOW = "2026-07-15T12:00:00.000Z";

function notes(reference: string, taskCount = 0): NotesDocumentV2 {
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

function store(cwd: string, document: NotesDocumentV2): void {
  localStorage.setItem(v2NotesKey(cwd), JSON.stringify(document));
  localStorage.setItem(legacyNotesKey(cwd), document.reference);
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

  seed(cwd: string, document: NotesDocumentV2, revision = 1): void {
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

  async migrateNotes(document: NotesDocumentV2): Promise<ProjectNotesMigrationOutcome> {
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
    document: NotesDocumentV2,
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

  publish(cwd: string, document: NotesDocumentV2, revision: number): void {
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
    fireEvent.change(screen.getByLabelText("Reference notes"), {
      target: { value: "updated reference" },
    });

    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
        "updated reference",
      ),
    );
    expect(localStorage.getItem(legacyNotesKey(cwd))).toBe("stale local");
    expect(JSON.parse(localStorage.getItem(v2NotesKey(cwd))!).reference).toBe("stale local");
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
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project A",
    );

    client.cwd = cwdB;
    view.rerender(<ProjectNotes cwd={cwdB} client={client} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));

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
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "recoverable local notes",
    );
  });

  it("shows a failed sidecar save while retaining the optimistic edit", async () => {
    const cwd = "/work/save-failure";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("saved reference"));
    client.saveOutcome = { status: "invalid" };
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
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
