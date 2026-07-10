import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNotesHandoffUnread } from "./notes-status";
import type { NotesDocumentV2, NotesLoadResult, NotesSaveResult } from "./notes-types";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  createNotesRepository,
  legacyNotesKey,
  parseNotesDocument,
  type NotesRepository,
  v2NotesKey,
} from "./notes-storage";

interface StorageEventTarget {
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
}

export interface UseProjectNotesOptions {
  storage?: Storage;
  repository?: NotesRepository;
  eventTarget?: StorageEventTarget;
  clock?: () => string;
  idFactory?: () => string;
}

export interface UseProjectNotesResult {
  value: string;
  onChange(value: string): void;
  document: NotesDocumentV2;
  changeCurrentFocus(value: string): void;
  createTask(text: string): void;
  editTask(id: string, text: string): void;
  toggleTask(id: string): void;
  moveTask(id: string, direction: "up" | "down"): void;
  archiveTask(id: string): void;
  restoreTask(id: string): void;
  changeHandoff(text: string): void;
  markHandoffPresented(expectedText: string, expectedUpdatedAt: string | null): void;
  diagnostics: {
    load: NotesLoadResult | null;
    save: NotesSaveResult | null;
  };
}

const systemClock = (): string => new Date().toISOString();

export function useProjectNotes(
  cwd: string | null,
  options: UseProjectNotesOptions = {},
): UseProjectNotesResult {
  const clock = options.clock ?? systemClock;
  const idFactory = useMemo(
    () => options.idFactory ?? (() => crypto.randomUUID()),
    [options.idFactory],
  );
  const storage = useMemo(() => options.storage ?? browserStorage(), [options.storage]);
  const repository = useMemo(
    () => options.repository ?? createNotesRepository(storage, clock),
    [options.repository, storage, clock],
  );
  const eventTarget: StorageEventTarget | undefined =
    options.eventTarget ?? (typeof window === "undefined" ? undefined : window);
  const [document, setDocument] = useState<NotesDocumentV2>(() =>
    createEmptyNotesDocument(clock()),
  );
  const [loadDiagnostics, setLoadDiagnostics] = useState<NotesLoadResult | null>(null);
  const [saveDiagnostics, setSaveDiagnostics] = useState<NotesSaveResult | null>(null);
  const activeCwdRef = useRef(cwd);
  const documentRef = useRef(document);

  const applyLoad = useCallback(
    (projectCwd: string) => {
      if (activeCwdRef.current !== projectCwd) return;
      const loaded = repository.load(projectCwd);
      if (activeCwdRef.current !== projectCwd) return;
      documentRef.current = loaded.document;
      setDocument(loaded.document);
      setLoadDiagnostics(loaded);
      setSaveDiagnostics(null);
    },
    [repository],
  );

  useEffect(() => {
    activeCwdRef.current = cwd;
    if (cwd === null) {
      const empty = createEmptyNotesDocument(clock());
      documentRef.current = empty;
      setDocument(empty);
      setLoadDiagnostics(null);
      setSaveDiagnostics(null);
      return;
    }
    applyLoad(cwd);
  }, [applyLoad, clock, cwd]);

  useEffect(() => {
    if (cwd === null || !eventTarget) return;
    const canonicalCwd = canonicalProjectKey(cwd);
    const canonicalV2Key = v2NotesKey(cwd);
    const exactLegacyKey = legacyNotesKey(cwd);

    const onStorage = (event: StorageEvent): void => {
      if (activeCwdRef.current !== cwd || event.key === null) return;
      const isV2Key = event.key === canonicalV2Key;
      const isLegacyKey =
        event.key === exactLegacyKey ||
        (event.key.startsWith("gg-notes:") &&
          canonicalProjectKey(event.key.slice("gg-notes:".length)) === canonicalCwd);
      if (!isV2Key && !isLegacyKey) return;

      // Reload first so migration diagnostics and structured state follow the
      // repository's normal path. The event payload then wins when canonical
      // cwd aliases have separate rollback keys, matching browser event order.
      applyLoad(cwd);
      if (event.newValue === null || activeCwdRef.current !== cwd) return;
      if (isV2Key) {
        const parsed = parseNotesDocument(event.newValue);
        if (!parsed.ok) return;
        documentRef.current = parsed.document;
        setDocument(parsed.document);
      } else {
        const nextDocument = { ...documentRef.current, reference: event.newValue };
        documentRef.current = nextDocument;
        setDocument(nextDocument);
      }
    };

    eventTarget.addEventListener("storage", onStorage);
    return () => eventTarget.removeEventListener("storage", onStorage);
  }, [applyLoad, cwd, eventTarget]);

  const commitDocument = useCallback(
    (projectCwd: string, update: (current: NotesDocumentV2) => NotesDocumentV2 | null) => {
      if (activeCwdRef.current !== projectCwd) return;
      const nextDocument = update(documentRef.current);
      if (nextDocument === null || activeCwdRef.current !== projectCwd) return;
      documentRef.current = nextDocument;
      setDocument(nextDocument);
      setSaveDiagnostics(repository.save(projectCwd, nextDocument));
    },
    [repository],
  );

  const onChange = useCallback(
    (value: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => ({ ...current, reference: value, updatedAt: clock() }));
    },
    [clock, commitDocument, cwd],
  );

  const changeCurrentFocus = useCallback(
    (value: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        if (current.currentFocus === value) return null;
        return { ...current, currentFocus: value, updatedAt: clock() };
      });
    },
    [clock, commitDocument, cwd],
  );

  const createTask = useCallback(
    (text: string) => {
      if (cwd === null) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      commitDocument(cwd, (current) => {
        const now = clock();
        return {
          ...current,
          tasks: [
            ...current.tasks,
            {
              id: idFactory(),
              text: trimmed,
              status: "todo",
              createdAt: now,
              updatedAt: now,
              completedAt: null,
              archivedAt: null,
            },
          ],
          updatedAt: now,
        };
      });
    },
    [clock, commitDocument, cwd, idFactory],
  );

  const editTask = useCallback(
    (id: string, text: string) => {
      if (cwd === null) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      commitDocument(cwd, (current) => {
        const index = current.tasks.findIndex((task) => task.id === id);
        const task = current.tasks[index];
        if (!task || task.archivedAt !== null || task.text === trimmed) return null;
        const now = clock();
        const tasks = [...current.tasks];
        tasks[index] = { ...task, text: trimmed, updatedAt: now };
        return { ...current, tasks, updatedAt: now };
      });
    },
    [clock, commitDocument, cwd],
  );

  const toggleTask = useCallback(
    (id: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        const index = current.tasks.findIndex((task) => task.id === id);
        const task = current.tasks[index];
        if (!task) return null;
        const now = clock();
        const done = task.status === "todo";
        const tasks = [...current.tasks];
        tasks[index] = {
          ...task,
          status: done ? "done" : "todo",
          completedAt: done ? now : null,
          updatedAt: now,
        };
        return { ...current, tasks, updatedAt: now };
      });
    },
    [clock, commitDocument, cwd],
  );

  const moveTask = useCallback(
    (id: string, direction: "up" | "down") => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        const activeIndexes = current.tasks
          .map((task, index) => (task.archivedAt === null ? index : -1))
          .filter((index) => index !== -1);
        const activePosition = activeIndexes.findIndex((index) => current.tasks[index]?.id === id);
        const targetPosition = activePosition + (direction === "up" ? -1 : 1);
        if (activePosition === -1 || targetPosition < 0 || targetPosition >= activeIndexes.length) {
          return null;
        }

        const sourceIndex = activeIndexes[activePosition]!;
        const targetIndex = activeIndexes[targetPosition]!;
        const tasks = [...current.tasks];
        [tasks[sourceIndex], tasks[targetIndex]] = [tasks[targetIndex]!, tasks[sourceIndex]!];
        return { ...current, tasks, updatedAt: clock() };
      });
    },
    [clock, commitDocument, cwd],
  );

  const archiveTask = useCallback(
    (id: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        const index = current.tasks.findIndex((task) => task.id === id);
        const task = current.tasks[index];
        if (!task || task.archivedAt !== null) return null;
        const now = clock();
        const tasks = [...current.tasks];
        tasks[index] = { ...task, archivedAt: now, updatedAt: now };
        return { ...current, tasks, updatedAt: now };
      });
    },
    [clock, commitDocument, cwd],
  );

  const restoreTask = useCallback(
    (id: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        const index = current.tasks.findIndex((task) => task.id === id);
        const task = current.tasks[index];
        if (!task || task.archivedAt === null) return null;
        const now = clock();
        const tasks = [...current.tasks];
        tasks[index] = { ...task, archivedAt: null, updatedAt: now };
        return { ...current, tasks, updatedAt: now };
      });
    },
    [clock, commitDocument, cwd],
  );

  const changeHandoff = useCallback(
    (text: string) => {
      if (cwd === null) return;
      commitDocument(cwd, (current) => {
        if (current.handoff.text === text) return null;
        const now = clock();
        return {
          ...current,
          handoff: { text, updatedAt: now, readAt: null },
          updatedAt: now,
        };
      });
    },
    [clock, commitDocument, cwd],
  );

  const markHandoffPresented = useCallback(
    (expectedText: string, expectedUpdatedAt: string | null) => {
      if (cwd === null || expectedUpdatedAt === null) return;
      commitDocument(cwd, (current) => {
        if (
          current.handoff.text !== expectedText ||
          current.handoff.updatedAt !== expectedUpdatedAt ||
          !isNotesHandoffUnread(current)
        ) {
          return null;
        }
        const now = clock();
        return {
          ...current,
          handoff: { ...current.handoff, readAt: now },
          updatedAt: now,
        };
      });
    },
    [clock, commitDocument, cwd],
  );

  return {
    value: document.reference,
    onChange,
    document,
    changeCurrentFocus,
    createTask,
    editTask,
    toggleTask,
    moveTask,
    archiveTask,
    restoreTask,
    changeHandoff,
    markHandoffPresented,
    diagnostics: { load: loadDiagnostics, save: saveDiagnostics },
  };
}

function browserStorage(): Storage {
  try {
    return window.localStorage;
  } catch (error) {
    return throwingStorage(error);
  }
}

function throwingStorage(error: unknown): Storage {
  const fail = (): never => {
    throw error;
  };
  return {
    get length() {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}
