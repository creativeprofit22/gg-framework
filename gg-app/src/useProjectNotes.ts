import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
}

export interface UseProjectNotesResult {
  value: string;
  onChange(value: string): void;
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

  const onChange = useCallback(
    (value: string) => {
      if (cwd === null || activeCwdRef.current !== cwd) return;
      const nextDocument = {
        ...documentRef.current,
        reference: value,
        updatedAt: clock(),
      };
      documentRef.current = nextDocument;
      setDocument(nextDocument);
      setSaveDiagnostics(repository.save(cwd, nextDocument));
    },
    [clock, cwd, repository],
  );

  return {
    value: document.reference,
    onChange,
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
