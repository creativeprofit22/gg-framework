import {
  canonicalProjectKey,
  notesSessionLinksEqual,
  type NotesSessionLink,
  type ProjectNotesLoadOutcome,
} from "@kenkaiiii/gg-core/project-notes";
import {
  isProjectNotesApplicationIdentity,
  type ProjectNotesDiagnosticConsistency,
  type ProjectNotesDiagnosticPhaseLink,
  type ProjectNotesStorageDiagnostics,
} from "@kenkaiiii/gg-core/project-notes-diagnostics";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type { ProjectNotesPaths } from "./project-notes-repository.js";

export interface StorageDiagnosticsRepository {
  paths(cwd: string): ProjectNotesPaths;
  load(cwd: string): Promise<ProjectNotesLoadOutcome>;
}

export interface StorageDiagnosticsSessionContext {
  cwd: string;
  logicalSessionId: string;
  currentSession: NotesSessionLink;
  activePhaseContext: ActivePhaseContextV1 | undefined;
}

export interface AppSidecarStorageDiagnostics {
  inspect(context: StorageDiagnosticsSessionContext): Promise<ProjectNotesStorageDiagnostics>;
}

export interface AppSidecarStorageDiagnosticsOptions {
  applicationIdentity: string | null;
  agentDataRoot: string;
  repository: StorageDiagnosticsRepository;
}

export function parseAppIdentityArgument(argv: readonly string[]): string | null {
  const identities = argv
    .filter((argument) => argument.startsWith("--gg-app-identity="))
    .map((argument) => argument.slice("--gg-app-identity=".length));
  return identities.length === 1 && isProjectNotesApplicationIdentity(identities[0])
    ? identities[0]!
    : null;
}

export function createAppSidecarStorageDiagnostics(
  options: AppSidecarStorageDiagnosticsOptions,
): AppSidecarStorageDiagnostics {
  return {
    async inspect(context) {
      const canonicalCwd = canonicalProjectKey(context.cwd);
      const paths = options.repository.paths(context.cwd);
      let loadOutcome: ProjectNotesLoadOutcome | null = null;
      try {
        loadOutcome = await options.repository.load(context.cwd);
      } catch {
        // Diagnostics fail closed without exposing filesystem error details.
      }
      return buildProjectNotesStorageDiagnostics({
        applicationIdentity: options.applicationIdentity,
        agentDataRoot: options.agentDataRoot,
        canonicalCwd,
        projectKey: canonicalCwd,
        projectNotesStore: { primaryPath: paths.primary, backupPath: paths.backup },
        logicalSessionId: context.logicalSessionId,
        currentSession: context.currentSession,
        activePhaseContext: projectActivePhaseContext(context.activePhaseContext),
        persistedPhaseBinding: persistedPhaseBinding(loadOutcome, context.activePhaseContext),
        storeAvailable: loadOutcome !== null && loadOutcome.status !== "corrupt",
      });
    },
  };
}

export interface BuildProjectNotesStorageDiagnosticsInput extends Omit<
  ProjectNotesStorageDiagnostics,
  "version" | "daemonOwner" | "consistency"
> {
  storeAvailable: boolean;
}

export function buildProjectNotesStorageDiagnostics(
  input: BuildProjectNotesStorageDiagnosticsInput,
): ProjectNotesStorageDiagnostics {
  return {
    version: 1,
    applicationIdentity: input.applicationIdentity,
    daemonOwner: "node-sidecar",
    agentDataRoot: input.agentDataRoot,
    canonicalCwd: input.canonicalCwd,
    projectKey: input.projectKey,
    projectNotesStore: input.projectNotesStore,
    logicalSessionId: input.logicalSessionId,
    currentSession: input.currentSession,
    activePhaseContext: input.activePhaseContext,
    persistedPhaseBinding: input.persistedPhaseBinding,
    consistency: diagnosticConsistency(input),
  };
}

function diagnosticConsistency(
  input: BuildProjectNotesStorageDiagnosticsInput,
): ProjectNotesDiagnosticConsistency {
  if (input.applicationIdentity === null) return "identity-mismatch";
  if (!input.storeAvailable) return "store-unavailable";
  if (
    input.projectKey !== input.canonicalCwd ||
    (input.activePhaseContext !== null &&
      input.activePhaseContext.projectKey !== input.projectKey) ||
    (input.persistedPhaseBinding !== null &&
      input.persistedPhaseBinding.projectKey !== input.projectKey)
  ) {
    return "project-mismatch";
  }
  if (input.activePhaseContext === null || input.persistedPhaseBinding === null) return "unbound";
  if (
    input.activePhaseContext.phaseId !== input.persistedPhaseBinding.phaseId ||
    !notesSessionLinksEqual(input.activePhaseContext.session, input.currentSession) ||
    !notesSessionLinksEqual(input.persistedPhaseBinding.session, input.currentSession)
  ) {
    return "bound-to-other-session";
  }
  return "consistent";
}

function projectActivePhaseContext(
  context: ActivePhaseContextV1 | undefined,
): ProjectNotesDiagnosticPhaseLink | null {
  if (!context) return null;
  return {
    phaseId: context.phase.id,
    projectKey: context.projectKey,
    session: context.session,
  };
}

function persistedPhaseBinding(
  outcome: ProjectNotesLoadOutcome | null,
  activeContext: ActivePhaseContextV1 | undefined,
): ProjectNotesDiagnosticPhaseLink | null {
  if (!activeContext || outcome?.status !== "ok") return null;
  const phase = outcome.snapshot.document.phases.find(
    (candidate) => candidate.id === activeContext.phase.id,
  );
  if (!phase?.session) return null;
  return {
    phaseId: phase.id,
    projectKey: outcome.snapshot.projectKey,
    session: phase.session,
  };
}
