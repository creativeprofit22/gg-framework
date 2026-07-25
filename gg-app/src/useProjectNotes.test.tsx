// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyNotesDocument, createNotesRepository, v2NotesKey } from "./notes-storage";
import type {
  NotesClient,
  NotesDocumentV2,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "./notes-types";
import { useProjectNotes } from "./useProjectNotes";

const NOW = "2026-07-25T12:00:00.000Z";
const LATER = "2026-07-25T12:01:00.000Z";

function notes(
  reference: string,
  currentFocus = "",
  tasks: NotesDocumentV2["tasks"] = [],
): NotesDocumentV2 {
  return {
    ...createEmptyNotesDocument(NOW),
    reference,
    currentFocus,
    tasks,
  };
}

function task(id = "task-1"): NotesDocumentV2["tasks"][number] {
  return {
    id,
    text: `Task ${id}`,
    status: "todo",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
  };
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface PendingSave {
  expectedRevision: number;
  document: NotesDocumentV2;
  resolve(outcome: ProjectNotesSaveOutcome): void;
}

class FakeNotesServer {
  readonly snapshots = new Map<string, ProjectNotesSnapshot>();
  readonly clients = new Set<FakeNotesClient>();
  migrationCreates = 0;

  connect(projectKey: string): FakeNotesClient {
    const client = new FakeNotesClient(this, projectKey);
    this.clients.add(client);
    return client;
  }

  read(projectKey: string): ProjectNotesReadOutcome {
    const snapshot = this.snapshots.get(projectKey);
    return snapshot
      ? { status: "ok", snapshot, recoveredFromBackup: false }
      : { status: "missing" };
  }

  migrate(projectKey: string, document: NotesDocumentV2): ProjectNotesMigrationOutcome {
    const existing = this.snapshots.get(projectKey);
    if (existing) return { status: "ok", snapshot: existing, migrated: false };
    const snapshot = { projectKey, revision: 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.migrationCreates += 1;
    this.emit(projectKey, snapshot);
    return { status: "ok", snapshot, migrated: true };
  }

  save(
    projectKey: string,
    expectedRevision: number,
    document: NotesDocumentV2,
  ): ProjectNotesSaveOutcome {
    const current = this.snapshots.get(projectKey);
    if (!current) return { status: "missing" };
    if (current.revision !== expectedRevision) return { status: "conflict", snapshot: current };
    const snapshot = { projectKey, revision: expectedRevision + 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(projectKey, snapshot);
    return { status: "ok", snapshot };
  }

  emit(projectKey: string, snapshot: ProjectNotesSnapshot): void {
    for (const client of this.clients) {
      if (client.projectKey === projectKey) client.emit({ type: "notes_change", data: snapshot });
    }
  }
}

class FakeNotesClient implements NotesClient {
  readonly listeners = new Set<(event: NotesSidecarEvent) => void>();
  readonly saveCalls: Array<{ expectedRevision: number; document: NotesDocumentV2 }> = [];
  readonly pendingSaves: PendingSave[] = [];
  getCalls = 0;
  deferSaves = false;
  migrationError: unknown = null;
  getOverride: (() => Promise<ProjectNotesReadOutcome>) | null = null;

  constructor(
    readonly server: FakeNotesServer,
    readonly projectKey: string,
  ) {}

  async getNotes(): Promise<ProjectNotesReadOutcome> {
    this.getCalls += 1;
    if (this.getOverride) return this.getOverride();
    return this.server.read(this.projectKey);
  }

  async migrateNotes(document: NotesDocumentV2): Promise<ProjectNotesMigrationOutcome> {
    if (this.migrationError) throw this.migrationError;
    return this.server.migrate(this.projectKey, document);
  }

  async saveNotes(
    expectedRevision: number,
    document: NotesDocumentV2,
  ): Promise<ProjectNotesSaveOutcome> {
    this.saveCalls.push({ expectedRevision, document });
    if (!this.deferSaves) return this.server.save(this.projectKey, expectedRevision, document);
    return new Promise((resolve) => {
      this.pendingSaves.push({ expectedRevision, document, resolve });
    });
  }

  subscribe(onEvent: (event: NotesSidecarEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  emit(event: NotesSidecarEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  flushNextSave(): void {
    const pending = this.pendingSaves.shift();
    if (!pending) throw new Error("no pending Notes save");
    pending.resolve(this.server.save(this.projectKey, pending.expectedRevision, pending.document));
  }
}

function seed(storage: Storage, cwd: string, document: NotesDocumentV2): void {
  storage.setItem(v2NotesKey(cwd), JSON.stringify(document));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const testClock = (): string => LATER;
const testIdFactory = (): string => "created-task";
const hookOptions = (
  client: NotesClient,
  storage: Storage,
): Parameters<typeof useProjectNotes>[1] => ({
  client,
  storage,
  clock: testClock,
  idFactory: testIdFactory,
});

afterEach(() => cleanup());

describe("useProjectNotes sidecar authority", () => {
  it("subscribes first and migrates a valid local v2 document exactly once", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const local = notes("  local\r\nbytes 😀\n", "focus", [task()]);
    seed(storage, cwd, local);
    const server = new FakeNotesServer();
    const client = server.connect(cwd);

    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    await waitFor(() => expect(hook.result.current.document).toEqual(local));
    expect(server.migrationCreates).toBe(1);
    expect(server.snapshots.get(cwd)).toEqual({ projectKey: cwd, revision: 1, document: local });
    expect(client.listeners.size).toBe(1);
  });

  it("converges simultaneous migrations on one revision-1 snapshot", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    seed(firstStorage, cwd, notes("first"));
    seed(secondStorage, cwd, notes("second"));
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);

    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));

    await waitFor(() => expect(first.result.current.document.reference).not.toBe(""));
    await waitFor(() =>
      expect(second.result.current.document).toEqual(first.result.current.document),
    );
    expect(server.migrationCreates).toBe(1);
    expect(server.snapshots.get(cwd)?.revision).toBe(1);
  });

  it("always prefers an existing sidecar snapshot over stale localStorage", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("stale local"));
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 7, document: notes("server wins") });
    const client = server.connect(cwd);

    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    await waitFor(() => expect(hook.result.current.document.reference).toBe("server wins"));
    expect(storage.getItem(v2NotesKey(cwd))).toContain("stale local");
  });

  it("refetches the authoritative snapshot when a reconnect ready event follows a missed change", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("before drop") });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("before drop"));

    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 2,
      document: notes("saved while disconnected"),
    });
    act(() => client.emit({ type: "ready", data: {} }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("saved while disconnected"),
    );
    expect(client.getCalls).toBe(2);
  });

  it("accepts a lower backup-recovery snapshot from an explicit ready refresh", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 5,
      document: notes("primary revision 5"),
    });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    const recovered = {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    };
    server.snapshots.set(cwd, recovered);
    client.getOverride = async () => ({
      status: "ok",
      snapshot: recovered,
      recoveredFromBackup: true,
    });
    act(() => client.emit({ type: "ready", data: {} }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("recovered backup revision 4"),
    );
    expect(client.getCalls).toBe(2);
  });

  it("survives browser-storage clearing and remounts from the sidecar", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("durable"));
    const server = new FakeNotesServer();
    const firstClient = server.connect(cwd);
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, storage)));
    await waitFor(() => expect(first.result.current.document.reference).toBe("durable"));
    first.unmount();
    storage.clear();

    const restartedClient = server.connect(cwd);
    const restarted = renderHook(() => useProjectNotes(cwd, hookOptions(restartedClient, storage)));

    await waitFor(() => expect(restarted.result.current.document.reference).toBe("durable"));
  });

  it("keeps local records and emergency edits recoverable when migration fails", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("recover me"));
    const server = new FakeNotesServer();
    const client = server.connect(cwd);
    client.migrationError = new Error("offline");
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("recover me"));

    act(() => hook.result.current.onChange("emergency edit"));

    expect(createNotesRepository(storage).load(cwd).document.reference).toBe("emergency edit");
    expect(hook.result.current.diagnostics.authority.map((item) => item.kind)).toContain(
      "migration-failed",
    );
    expect(server.snapshots.has(cwd)).toBe(false);
  });

  it("serializes rapid text writes and coalesces only the unsent tail", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    client.deferSaves = true;
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("base"));

    act(() => hook.result.current.onChange("a"));
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    act(() => {
      hook.result.current.onChange("ab");
      hook.result.current.onChange("abc");
    });
    expect(hook.result.current.document.reference).toBe("abc");

    act(() => client.flushNextSave());
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    act(() => client.flushNextSave());
    await waitFor(() => expect(server.snapshots.get(cwd)?.document.reference).toBe("abc"));

    expect(client.saveCalls.map((call) => call.document.reference)).toEqual(["a", "abc"]);
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([1, 2]);
  });

  it("rebases a mutation onto a lower backup-recovery conflict without looping", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 5,
      document: notes("primary revision 5"),
    });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    });
    act(() => hook.result.current.onChange("rebased edit"));

    await waitFor(() => expect(server.snapshots.get(cwd)?.document.reference).toBe("rebased edit"));
    expect(server.snapshots.get(cwd)?.revision).toBe(5);
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([5, 4]);
    await Promise.resolve();
    expect(client.saveCalls).toHaveLength(2);
  });

  it("rebases unrelated concurrent operations and converges both hooks", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base", "base") });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.reference).toBe("base"));
    await waitFor(() => expect(second.result.current.document.reference).toBe("base"));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.onChange("first reference"));
    act(() => second.result.current.changeCurrentFocus("second focus"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    await waitFor(() => expect(first.result.current.document.currentFocus).toBe("second focus"));
    expect(first.result.current.document.reference).toBe("first reference");
    expect(second.result.current.document).toEqual(first.result.current.document);
  });

  it("drops a stale task operation that became invalid instead of resurrecting it", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task()]),
    });
    const archiveClient = server.connect(cwd);
    const toggleClient = server.connect(cwd);
    const archiveStorage = new MemoryStorage();
    const toggleStorage = new MemoryStorage();
    const archiveHook = renderHook(() =>
      useProjectNotes(cwd, hookOptions(archiveClient, archiveStorage)),
    );
    const toggleHook = renderHook(() =>
      useProjectNotes(cwd, hookOptions(toggleClient, toggleStorage)),
    );
    await waitFor(() => expect(archiveHook.result.current.document.tasks).toHaveLength(1));
    await waitFor(() => expect(toggleHook.result.current.document.tasks).toHaveLength(1));
    archiveClient.deferSaves = true;
    toggleClient.deferSaves = true;

    act(() => archiveHook.result.current.archiveTask("task-1"));
    act(() => toggleHook.result.current.toggleTask("task-1"));
    await waitFor(() => expect(archiveClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(toggleClient.pendingSaves).toHaveLength(1));
    act(() => archiveClient.flushNextSave());
    act(() => toggleClient.flushNextSave());

    await waitFor(() => expect(toggleClient.pendingSaves).toHaveLength(0));
    const winner = server.snapshots.get(cwd)!;
    expect(winner.revision).toBe(2);
    expect(winner.document.tasks[0]).toMatchObject({ status: "todo", archivedAt: LATER });
  });

  it("rebases concurrent identical toggles to one target status", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task()]),
    });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.tasks).toHaveLength(1));
    await waitFor(() => expect(second.result.current.document.tasks).toHaveLength(1));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.toggleTask("task-1"));
    act(() => second.result.current.toggleTask("task-1"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(0));
    expect(server.snapshots.get(cwd)).toMatchObject({
      revision: 2,
      document: { tasks: [{ status: "done", completedAt: LATER }] },
    });
    expect(secondClient.saveCalls).toHaveLength(1);
  });

  it("rebases concurrent identical moves to one target order", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task("task-1"), task("task-2"), task("task-3")]),
    });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.tasks).toHaveLength(3));
    await waitFor(() => expect(second.result.current.document.tasks).toHaveLength(3));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.moveTask("task-3", "up"));
    act(() => second.result.current.moveTask("task-3", "up"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(0));
    expect(server.snapshots.get(cwd)?.revision).toBe(2);
    expect(server.snapshots.get(cwd)?.document.tasks.map((item) => item.id)).toEqual([
      "task-1",
      "task-3",
      "task-2",
    ]);
    expect(secondClient.saveCalls).toHaveLength(1);
  });

  it("accepts a lower authoritative snapshot from a backup-recovery read", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const client = server.connect(cwd);
    const opened = deferred<ProjectNotesReadOutcome>();
    client.getOverride = () => opened.promise;
    const storage = new MemoryStorage();
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    act(() =>
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 5, document: notes("primary revision 5") },
      }),
    );
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    const recovered = {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    };
    server.snapshots.set(cwd, recovered);
    act(() => opened.resolve({ status: "ok", snapshot: recovered, recoveredFromBackup: true }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("recovered backup revision 4"),
    );
    act(() => hook.result.current.onChange("edit after recovery"));
    await waitFor(() =>
      expect(server.snapshots.get(cwd)?.document.reference).toBe("edit after recovery"),
    );
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([4]);
  });

  it("applies only newer same-project events", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 3, document: notes("current") });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("current"));

    act(() => {
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 2, document: notes("stale") },
      });
      client.emit({
        type: "notes_change",
        data: { projectKey: "/work/other", revision: 99, document: notes("other") },
      });
    });
    expect(hook.result.current.document.reference).toBe("current");

    act(() =>
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 4, document: notes("newer") },
      }),
    );
    expect(hook.result.current.document.reference).toBe("newer");
  });

  it("ignores late responses and callbacks from the previous project", async () => {
    const server = new FakeNotesServer();
    const slow = server.connect("/work/a");
    const getA = deferred<ProjectNotesReadOutcome>();
    slow.getOverride = () => getA.promise;
    server.snapshots.set("/work/b", {
      projectKey: "/work/b",
      revision: 1,
      document: notes("project B"),
    });
    const fast = server.connect("/work/b");
    const storage = new MemoryStorage();
    const hook = renderHook(
      ({ cwd, client }: { cwd: string; client: NotesClient }) =>
        useProjectNotes(cwd, hookOptions(client, storage)),
      { initialProps: { cwd: "/work/a", client: slow as NotesClient } },
    );

    hook.rerender({ cwd: "/work/b", client: fast });
    await waitFor(() => expect(hook.result.current.document.reference).toBe("project B"));
    act(() =>
      getA.resolve({
        status: "ok",
        recoveredFromBackup: false,
        snapshot: { projectKey: "/work/a", revision: 9, document: notes("late A") },
      }),
    );
    act(() =>
      slow.emit({
        type: "notes_change",
        data: { projectKey: "/work/a", revision: 10, document: notes("event A") },
      }),
    );

    await Promise.resolve();
    expect(hook.result.current.document.reference).toBe("project B");
    expect(slow.listeners.size).toBe(0);
  });
});
