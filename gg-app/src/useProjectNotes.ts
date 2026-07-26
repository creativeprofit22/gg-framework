import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNotesHandoffUnread } from "./notes-status";
import {
  isNotesChangeEvent,
  isNotesReadyEvent,
  type NotesAuthorityDiagnostic,
  type NotesClient,
  type NotesDocumentV3,
  type NotesLoadResult,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesSaveResult,
  type ProjectNotesSnapshot,
} from "./notes-types";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  createNotesRepository,
  type NotesRepository,
} from "./notes-storage";

export interface UseProjectNotesOptions {
  client?: NotesClient;
  storage?: Storage;
  repository?: NotesRepository;
  clock?: () => string;
  idFactory?: () => string;
}

export interface NotesPhaseInput {
  title: string;
  goal: string;
  doneWhen: string[];
}

export interface UseProjectNotesResult {
  value: string;
  onChange(value: string): void;
  document: NotesDocumentV3;
  changeCurrentFocus(value: string): void;
  createTask(text: string): void;
  editTask(id: string, text: string): void;
  toggleTask(id: string): void;
  moveTask(id: string, direction: "up" | "down"): void;
  archiveTask(id: string): void;
  restoreTask(id: string): void;
  createPhase(input: NotesPhaseInput): void;
  editPhase(id: string, input: NotesPhaseInput): void;
  movePhase(id: string, direction: "up" | "down"): void;
  changePhaseStatus(id: string, status: NotesPhaseStatus): void;
  archivePhase(id: string): void;
  restorePhase(id: string): void;
  changeHandoff(text: string): void;
  markHandoffPresented(expectedText: string, expectedUpdatedAt: string | null): void;
  diagnostics: {
    load: NotesLoadResult | null;
    save: NotesSaveResult | null;
    authority: NotesAuthorityDiagnostic[];
  };
}

type AuthorityMode = "opening" | "sidecar" | "fallback" | "none";
type CoalesceKey = "reference" | "current-focus" | "handoff";

interface NotesMutation {
  id: number;
  coalesceKey?: CoalesceKey;
  apply(document: NotesDocumentV3): NotesDocumentV3 | null;
}

const systemClock = (): string => new Date().toISOString();

export function useProjectNotes(
  cwd: string | null,
  options: UseProjectNotesOptions = {},
): UseProjectNotesResult {
  const client = options.client;
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
  const [document, setDocument] = useState<NotesDocumentV3>(() =>
    createEmptyNotesDocument(clock()),
  );
  const [loadDiagnostics, setLoadDiagnostics] = useState<NotesLoadResult | null>(null);
  const [saveDiagnostics, setSaveDiagnostics] = useState<NotesSaveResult | null>(null);
  const [authorityDiagnostics, setAuthorityDiagnostics] = useState<NotesAuthorityDiagnostic[]>([]);

  const documentRef = useRef(document);
  const activeCwdRef = useRef(cwd);
  const epochRef = useRef(0);
  const modeRef = useRef<AuthorityMode>(cwd === null ? "none" : "opening");
  const authoritativeRef = useRef<ProjectNotesSnapshot | null>(null);
  const queueRef = useRef<NotesMutation[]>([]);
  const inFlightMutationIdRef = useRef<number | null>(null);
  const nextMutationIdRef = useRef(0);
  const processQueueRef = useRef<() => void>(() => undefined);

  const showDocument = useCallback((next: NotesDocumentV3) => {
    documentRef.current = next;
    setDocument(next);
  }, []);

  const addAuthorityDiagnostic = useCallback((diagnostic: NotesAuthorityDiagnostic) => {
    setAuthorityDiagnostics((current) => [...current, diagnostic]);
  }, []);

  const renderSidecarState = useCallback(() => {
    const authoritative = authoritativeRef.current;
    if (!authoritative) return;
    showDocument(replayMutations(authoritative.document, queueRef.current));
  }, [showDocument]);

  const adoptSnapshot = useCallback(
    (
      snapshot: ProjectNotesSnapshot,
      expectedProjectKey: string,
      epoch: number,
      authoritativeResponse = false,
    ): boolean => {
      if (
        epoch !== epochRef.current ||
        activeCwdRef.current === null ||
        snapshot.projectKey !== expectedProjectKey
      ) {
        return false;
      }
      const current = authoritativeRef.current;
      if (!authoritativeResponse && current && snapshot.revision <= current.revision) return false;
      authoritativeRef.current = snapshot;
      modeRef.current = "sidecar";
      setLoadDiagnostics(null);
      setSaveDiagnostics(null);
      renderSidecarState();
      return true;
    },
    [renderSidecarState],
  );

  const enterFallback = useCallback(
    (
      projectCwd: string,
      loaded: NotesLoadResult,
      diagnostic: NotesAuthorityDiagnostic | null,
      epoch: number,
    ) => {
      if (epoch !== epochRef.current || activeCwdRef.current !== projectCwd) return;
      modeRef.current = "fallback";
      authoritativeRef.current = null;
      const pending = queueRef.current;
      const fallbackDocument = replayMutations(loaded.document, pending);
      queueRef.current = [];
      inFlightMutationIdRef.current = null;
      showDocument(fallbackDocument);
      setLoadDiagnostics(loaded);
      let save: NotesSaveResult | null = null;
      if (pending.length > 0) save = repository.save(projectCwd, fallbackDocument);
      setSaveDiagnostics(save);
      if (diagnostic) addAuthorityDiagnostic(diagnostic);
      addAuthorityDiagnostic({ kind: "fallback-storage", load: loaded, save });
    },
    [addAuthorityDiagnostic, repository, showDocument],
  );

  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    activeCwdRef.current = cwd;
    queueRef.current = [];
    inFlightMutationIdRef.current = null;
    authoritativeRef.current = null;
    setAuthorityDiagnostics([]);
    setLoadDiagnostics(null);
    setSaveDiagnostics(null);

    if (cwd === null) {
      modeRef.current = "none";
      showDocument(createEmptyNotesDocument(clock()));
      return;
    }

    const projectCwd = cwd;
    const projectKey = canonicalProjectKey(projectCwd);
    modeRef.current = client ? "opening" : "fallback";
    showDocument(createEmptyNotesDocument(clock()));

    if (!client) {
      const loaded = repository.load(projectCwd);
      enterFallback(projectCwd, loaded, null, epoch);
      return;
    }

    let readGeneration = 0;
    const readAuthoritativeNotes = async (): Promise<void> => {
      const requestGeneration = ++readGeneration;
      try {
        const opened = await client.getNotes();
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current === "fallback" ||
          requestGeneration !== readGeneration
        ) {
          return;
        }

        if (opened.status === "ok") {
          if (opened.snapshot.projectKey !== projectKey) {
            const diagnostic: NotesAuthorityDiagnostic = {
              kind: "sidecar-open",
              error: new Error("sidecar returned Notes for a different project"),
            };
            if (authoritativeRef.current && modeRef.current === "sidecar") {
              addAuthorityDiagnostic(diagnostic);
            } else {
              enterFallback(projectCwd, repository.load(projectCwd), diagnostic, epoch);
            }
            return;
          }

          if (
            opened.recoveredFromBackup ||
            !authoritativeRef.current ||
            opened.snapshot.revision > authoritativeRef.current.revision
          ) {
            adoptSnapshot(opened.snapshot, projectKey, epoch, opened.recoveredFromBackup);
          }
          processQueueRef.current();
          return;
        }

        if (authoritativeRef.current && modeRef.current === "sidecar") {
          addAuthorityDiagnostic(
            opened.status === "corrupt"
              ? { kind: "sidecar-corrupt", corruption: opened }
              : {
                  kind: "sidecar-open",
                  error: new Error("authoritative Notes snapshot is missing"),
                },
          );
          processQueueRef.current();
          return;
        }

        const loaded = repository.load(projectCwd);
        if (opened.status === "corrupt") {
          enterFallback(projectCwd, loaded, { kind: "sidecar-corrupt", corruption: opened }, epoch);
          return;
        }
        if (
          loaded.migrationEligibility === "ineligible-unreadable" ||
          loaded.migrationEligibility === "ineligible-invalid-document"
        ) {
          enterFallback(projectCwd, loaded, { kind: "migration-refused", load: loaded }, epoch);
          return;
        }

        try {
          const migrated = await client.migrateNotes(loaded.document);
          if (
            epoch !== epochRef.current ||
            activeCwdRef.current !== projectCwd ||
            requestGeneration !== readGeneration
          ) {
            return;
          }
          if (migrated.status === "ok") {
            if (
              migrated.snapshot.projectKey === projectKey &&
              (!authoritativeRef.current ||
                migrated.snapshot.revision > authoritativeRef.current.revision)
            ) {
              adoptSnapshot(migrated.snapshot, projectKey, epoch);
            }
            processQueueRef.current();
            return;
          }
          if (migrated.status === "corrupt") {
            enterFallback(
              projectCwd,
              loaded,
              { kind: "sidecar-corrupt", corruption: migrated },
              epoch,
            );
            return;
          }
          if (migrated.status === "invalid") {
            enterFallback(
              projectCwd,
              loaded,
              { kind: "migration-failed", error: migrated.error },
              epoch,
            );
          }
        } catch (error) {
          if (authoritativeRef.current && modeRef.current === "sidecar") {
            addAuthorityDiagnostic({ kind: "migration-failed", error });
            processQueueRef.current();
          } else {
            enterFallback(projectCwd, loaded, { kind: "migration-failed", error }, epoch);
          }
        }
      } catch (error) {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current === "fallback" ||
          requestGeneration !== readGeneration
        ) {
          return;
        }
        if (authoritativeRef.current && modeRef.current === "sidecar") {
          addAuthorityDiagnostic({ kind: "sidecar-open", error });
          processQueueRef.current();
        } else {
          enterFallback(
            projectCwd,
            repository.load(projectCwd),
            { kind: "sidecar-open", error },
            epoch,
          );
        }
      }
    };

    const unsubscribe = client.subscribe((event) => {
      if (epoch !== epochRef.current || modeRef.current === "fallback") return;
      if (isNotesReadyEvent(event)) {
        void readAuthoritativeNotes();
        return;
      }
      if (!isNotesChangeEvent(event)) return;
      if (adoptSnapshot(event.data, projectKey, epoch)) processQueueRef.current();
    });

    void readAuthoritativeNotes();

    return () => {
      unsubscribe();
      if (epochRef.current === epoch) epochRef.current += 1;
    };
  }, [
    addAuthorityDiagnostic,
    adoptSnapshot,
    client,
    clock,
    cwd,
    enterFallback,
    repository,
    showDocument,
  ]);

  const processQueue = useCallback(() => {
    const projectCwd = activeCwdRef.current;
    const authoritative = authoritativeRef.current;
    const mutation = queueRef.current[0];
    if (
      !client ||
      projectCwd === null ||
      modeRef.current !== "sidecar" ||
      inFlightMutationIdRef.current !== null ||
      !authoritative ||
      !mutation
    ) {
      return;
    }

    const epoch = epochRef.current;
    const nextDocument = mutation.apply(authoritative.document);
    if (nextDocument === null) {
      queueRef.current.shift();
      renderSidecarState();
      queueMicrotask(() => processQueueRef.current());
      return;
    }

    inFlightMutationIdRef.current = mutation.id;
    void client
      .saveNotes(authoritative.revision, nextDocument)
      .then((outcome) => {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current !== "sidecar" ||
          inFlightMutationIdRef.current !== mutation.id
        ) {
          return;
        }
        inFlightMutationIdRef.current = null;
        if (outcome.status === "ok") {
          queueRef.current = queueRef.current.filter((queued) => queued.id !== mutation.id);
          if (
            !authoritativeRef.current ||
            outcome.snapshot.revision > authoritativeRef.current.revision
          ) {
            authoritativeRef.current = outcome.snapshot;
          }
          setSaveDiagnostics(null);
          setAuthorityDiagnostics((current) =>
            current.filter((diagnostic) => diagnostic.kind !== "save-failed"),
          );
          renderSidecarState();
          queueMicrotask(() => processQueueRef.current());
          return;
        }
        if (outcome.status === "conflict") {
          adoptSnapshot(outcome.snapshot, canonicalProjectKey(projectCwd), epoch, true);
          queueMicrotask(() => processQueueRef.current());
          return;
        }
        if (outcome.status === "invalid") {
          addAuthorityDiagnostic({ kind: "save-failed", error: outcome.error });
          return;
        }
        addAuthorityDiagnostic({
          kind: "save-failed",
          error: new Error(`sidecar Notes save failed: ${outcome.status}`),
        });
      })
      .catch((error) => {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          inFlightMutationIdRef.current !== mutation.id
        ) {
          return;
        }
        inFlightMutationIdRef.current = null;
        addAuthorityDiagnostic({ kind: "save-failed", error });
      });
  }, [addAuthorityDiagnostic, adoptSnapshot, client, renderSidecarState]);
  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  const enqueueMutation = useCallback(
    (mutation: Omit<NotesMutation, "id">) => {
      const projectCwd = activeCwdRef.current;
      if (projectCwd === null || modeRef.current === "none") return;
      const queued: NotesMutation = { ...mutation, id: ++nextMutationIdRef.current };

      if (modeRef.current === "fallback") {
        const next = queued.apply(documentRef.current);
        if (next === null) return;
        showDocument(next);
        setSaveDiagnostics(repository.save(projectCwd, next));
        return;
      }

      const queue = queueRef.current;
      const tail = queue[queue.length - 1];
      if (
        queued.coalesceKey &&
        tail?.coalesceKey === queued.coalesceKey &&
        tail.id !== inFlightMutationIdRef.current
      ) {
        queue[queue.length - 1] = queued;
      } else {
        queue.push(queued);
      }

      if (authoritativeRef.current) renderSidecarState();
      else {
        const next = queued.apply(documentRef.current);
        if (next !== null) showDocument(next);
      }
      processQueueRef.current();
    },
    [renderSidecarState, repository, showDocument],
  );

  const onChange = useCallback(
    (value: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "reference",
        apply: (current) =>
          current.reference === value ? null : { ...current, reference: value, updatedAt: now },
      });
    },
    [clock, enqueueMutation],
  );

  const changeCurrentFocus = useCallback(
    (value: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "current-focus",
        apply: (current) =>
          current.currentFocus === value
            ? null
            : { ...current, currentFocus: value, updatedAt: now },
      });
    },
    [clock, enqueueMutation],
  );

  const createTask = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = clock();
      const id = idFactory();
      enqueueMutation({
        apply: (current) =>
          current.tasks.some((task) => task.id === id)
            ? null
            : {
                ...current,
                tasks: [
                  ...current.tasks,
                  {
                    id,
                    text: trimmed,
                    status: "todo",
                    createdAt: now,
                    updatedAt: now,
                    completedAt: null,
                    archivedAt: null,
                  },
                ],
                updatedAt: now,
              },
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const editTask = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = clock();
      enqueueMutation({
        apply: (current) => {
          const index = current.tasks.findIndex((task) => task.id === id);
          const task = current.tasks[index];
          if (!task || task.archivedAt !== null || task.text === trimmed) return null;
          const tasks = [...current.tasks];
          tasks[index] = { ...task, text: trimmed, updatedAt: now };
          return { ...current, tasks, updatedAt: now };
        },
      });
    },
    [clock, enqueueMutation],
  );

  const toggleTask = useCallback(
    (id: string) => {
      const selectedTask = documentRef.current.tasks.find((task) => task.id === id);
      if (!selectedTask || selectedTask.archivedAt !== null) return;
      const now = clock();
      const targetStatus = selectedTask.status === "todo" ? "done" : "todo";
      enqueueMutation({
        apply: (current) => {
          const index = current.tasks.findIndex((task) => task.id === id);
          const task = current.tasks[index];
          if (!task || task.archivedAt !== null || task.status === targetStatus) return null;
          const tasks = [...current.tasks];
          tasks[index] = {
            ...task,
            status: targetStatus,
            completedAt: targetStatus === "done" ? now : null,
            updatedAt: now,
          };
          return { ...current, tasks, updatedAt: now };
        },
      });
    },
    [clock, enqueueMutation],
  );

  const moveTask = useCallback(
    (id: string, direction: "up" | "down") => {
      const activeTasks = documentRef.current.tasks.filter((task) => task.archivedAt === null);
      const activePosition = activeTasks.findIndex((task) => task.id === id);
      const targetPosition = activePosition + (direction === "up" ? -1 : 1);
      const targetId = activeTasks[targetPosition]?.id;
      if (activePosition === -1 || !targetId) return;
      const now = clock();
      const placeBeforeTarget = direction === "up";
      enqueueMutation({
        apply: (current) => {
          const activeIds = current.tasks
            .filter((task) => task.archivedAt === null)
            .map((task) => task.id);
          const sourcePosition = activeIds.indexOf(id);
          const anchorPosition = activeIds.indexOf(targetId);
          if (sourcePosition === -1 || anchorPosition === -1) return null;
          if (
            (placeBeforeTarget && sourcePosition < anchorPosition) ||
            (!placeBeforeTarget && sourcePosition > anchorPosition)
          ) {
            return null;
          }

          const tasks = [...current.tasks];
          const sourceIndex = tasks.findIndex((task) => task.id === id);
          const [movedTask] = tasks.splice(sourceIndex, 1);
          if (!movedTask) return null;
          const targetIndex = tasks.findIndex((task) => task.id === targetId);
          tasks.splice(placeBeforeTarget ? targetIndex : targetIndex + 1, 0, movedTask);
          return { ...current, tasks, updatedAt: now };
        },
      });
    },
    [clock, enqueueMutation],
  );

  const archiveTask = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        apply: (current) =>
          updateTask(current, id, now, (task) =>
            task.archivedAt === null ? { ...task, archivedAt: now, updatedAt: now } : null,
          ),
      });
    },
    [clock, enqueueMutation],
  );

  const restoreTask = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        apply: (current) =>
          updateTask(current, id, now, (task) =>
            task.archivedAt !== null ? { ...task, archivedAt: null, updatedAt: now } : null,
          ),
      });
    },
    [clock, enqueueMutation],
  );

  const createPhase = useCallback(
    (input: NotesPhaseInput) => {
      const title = input.title.trim();
      if (!title) return;
      const goal = input.goal.trim();
      const doneWhen = normalizeDoneWhen(input.doneWhen);
      const now = clock();
      const id = idFactory();
      enqueueMutation({
        apply: (current) => {
          if (current.phases.some((phase) => phase.id === id)) return null;
          const phase: NotesPhase = {
            id,
            title,
            goal,
            doneWhen,
            order: current.phases.length,
            status: "not-started",
            sourcePrompt: "",
            referenceIds: [],
            session: null,
            reminder: null,
            attentionReason: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            archivedAt: null,
            overrides: { status: null, referenceIds: null },
            lifecycleEvents: [],
          };
          return { ...current, phases: [...current.phases, phase], updatedAt: now };
        },
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const editPhase = useCallback(
    (id: string, input: NotesPhaseInput) => {
      const title = input.title.trim();
      if (!title) return;
      const goal = input.goal.trim();
      const doneWhen = normalizeDoneWhen(input.doneWhen);
      const now = clock();
      enqueueMutation({
        apply: (current) =>
          updatePhase(current, id, now, (phase) => {
            if (phase.archivedAt !== null) return null;
            if (
              phase.title === title &&
              phase.goal === goal &&
              arraysEqual(phase.doneWhen, doneWhen)
            ) {
              return null;
            }
            return { ...phase, title, goal, doneWhen, updatedAt: now };
          }),
      });
    },
    [clock, enqueueMutation],
  );

  const movePhase = useCallback(
    (id: string, direction: "up" | "down") => {
      const visiblePhases = documentRef.current.phases.filter((phase) => phase.archivedAt === null);
      const visiblePosition = visiblePhases.findIndex((phase) => phase.id === id);
      const targetId = visiblePhases[visiblePosition + (direction === "up" ? -1 : 1)]?.id;
      if (visiblePosition === -1 || !targetId) return;
      const now = clock();
      const placeBeforeTarget = direction === "up";
      enqueueMutation({
        apply: (current) => {
          const visiblePhases = current.phases.filter((phase) => phase.archivedAt === null);
          const sourcePosition = visiblePhases.findIndex((phase) => phase.id === id);
          const anchorPosition = visiblePhases.findIndex((phase) => phase.id === targetId);
          if (sourcePosition === -1 || anchorPosition === -1) return null;
          if (
            (placeBeforeTarget && sourcePosition < anchorPosition) ||
            (!placeBeforeTarget && sourcePosition > anchorPosition)
          ) {
            return null;
          }

          const reorderedVisiblePhases = [...visiblePhases];
          const [movedPhase] = reorderedVisiblePhases.splice(sourcePosition, 1);
          if (!movedPhase) return null;
          const targetPosition = reorderedVisiblePhases.findIndex((phase) => phase.id === targetId);
          if (targetPosition === -1) return null;
          reorderedVisiblePhases.splice(
            placeBeforeTarget ? targetPosition : targetPosition + 1,
            0,
            movedPhase,
          );

          let visibleIndex = 0;
          const phases = current.phases.map((phase) =>
            phase.archivedAt === null ? reorderedVisiblePhases[visibleIndex++]! : phase,
          );
          return { ...current, phases: normalizePhaseOrder(phases), updatedAt: now };
        },
      });
    },
    [clock, enqueueMutation],
  );

  const changePhaseStatus = useCallback(
    (id: string, status: NotesPhaseStatus) => {
      const now = clock();
      const eventId = idFactory();
      enqueueMutation({
        apply: (current) =>
          updatePhase(current, id, now, (phase) => {
            if (phase.archivedAt !== null || phase.status === status) return null;
            const timestamp = chronologicalTimestamp(now, phase);
            return {
              ...phase,
              status,
              attentionReason: status === "needs-attention" ? phase.attentionReason : null,
              updatedAt: timestamp,
              completedAt: status === "done" || status === "cancelled" ? timestamp : null,
              overrides: {
                ...phase.overrides,
                status: { value: status, source: "user", updatedAt: timestamp },
              },
              lifecycleEvents: [
                ...phase.lifecycleEvents,
                {
                  id: eventId,
                  fromStatus: phase.status,
                  toStatus: status,
                  source: "user",
                  timestamp,
                  reason:
                    status === "cancelled" ? "Phase cancelled by user" : "Status changed by user",
                },
              ],
            };
          }),
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const archivePhase = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        apply: (current) =>
          updatePhase(current, id, now, (phase) =>
            phase.archivedAt === null ? { ...phase, archivedAt: now, updatedAt: now } : null,
          ),
      });
    },
    [clock, enqueueMutation],
  );

  const restorePhase = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        apply: (current) =>
          updatePhase(current, id, now, (phase) =>
            phase.archivedAt !== null ? { ...phase, archivedAt: null, updatedAt: now } : null,
          ),
      });
    },
    [clock, enqueueMutation],
  );

  const changeHandoff = useCallback(
    (text: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "handoff",
        apply: (current) =>
          current.handoff.text === text
            ? null
            : {
                ...current,
                handoff: { text, updatedAt: now, readAt: null },
                updatedAt: now,
              },
      });
    },
    [clock, enqueueMutation],
  );

  const markHandoffPresented = useCallback(
    (expectedText: string, expectedUpdatedAt: string | null) => {
      if (expectedUpdatedAt === null) return;
      const now = clock();
      enqueueMutation({
        apply: (current) => {
          if (
            current.handoff.text !== expectedText ||
            current.handoff.updatedAt !== expectedUpdatedAt ||
            !isNotesHandoffUnread(current)
          ) {
            return null;
          }
          return {
            ...current,
            handoff: { ...current.handoff, readAt: now },
            updatedAt: now,
          };
        },
      });
    },
    [clock, enqueueMutation],
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
    createPhase,
    editPhase,
    movePhase,
    changePhaseStatus,
    archivePhase,
    restorePhase,
    changeHandoff,
    markHandoffPresented,
    diagnostics: {
      load: loadDiagnostics,
      save: saveDiagnostics,
      authority: authorityDiagnostics,
    },
  };
}

function replayMutations(
  base: NotesDocumentV3,
  mutations: readonly NotesMutation[],
): NotesDocumentV3 {
  let current = base;
  for (const mutation of mutations) current = mutation.apply(current) ?? current;
  return current;
}

function updateTask(
  current: NotesDocumentV3,
  id: string,
  updatedAt: string,
  update: (task: NotesDocumentV3["tasks"][number]) => NotesDocumentV3["tasks"][number] | null,
): NotesDocumentV3 | null {
  const index = current.tasks.findIndex((task) => task.id === id);
  const task = current.tasks[index];
  if (!task) return null;
  const nextTask = update(task);
  if (!nextTask) return null;
  const tasks = [...current.tasks];
  tasks[index] = nextTask;
  return { ...current, tasks, updatedAt };
}

function updatePhase(
  current: NotesDocumentV3,
  id: string,
  updatedAt: string,
  update: (phase: NotesPhase) => NotesPhase | null,
): NotesDocumentV3 | null {
  const index = current.phases.findIndex((phase) => phase.id === id);
  const phase = current.phases[index];
  if (!phase) return null;
  const nextPhase = update(phase);
  if (!nextPhase) return null;
  const phases = [...current.phases];
  phases[index] = nextPhase;
  return { ...current, phases, updatedAt };
}

function normalizeDoneWhen(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizePhaseOrder(phases: readonly NotesPhase[]): NotesPhase[] {
  return phases.map((phase, order) => (phase.order === order ? phase : { ...phase, order }));
}

function chronologicalTimestamp(now: string, phase: NotesPhase): string {
  const previous = phase.lifecycleEvents[phase.lifecycleEvents.length - 1]?.timestamp;
  return previous && Date.parse(previous) > Date.parse(now) ? previous : now;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
