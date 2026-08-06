import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  canonicalProjectKey,
  type NotesPhase,
  type NotesRoadmapCompletionReview,
  type NotesRoadmapStatusUpdate,
  type ProjectNotesLoadOutcome,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  RoadmapInspection,
  RoadmapInspectionOutcome,
  RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import {
  type AppSidecarRoadmapDraftCoordinator,
  type RoadmapPhaseDraftCreateResult,
} from "./app-sidecar-roadmap-drafts.js";
import { createRoadmapInspectTool } from "./tools/roadmap-inspect.js";
import {
  createRoadmapPhaseDraftTool,
  type RoadmapPhaseDraftToolResult,
} from "./tools/roadmap-phase-draft.js";

export const APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT = `
## App Roadmap intent

The app provides roadmap_inspect and roadmap_phase_draft for the structured Project Notes Roadmap.
- Treat an unqualified natural-language request to create our roadmap, add work to our roadmap, or extend our roadmap as a request about that structured Roadmap, not a roadmap file.
- For those requests, call roadmap_inspect first and compare the request with every current phase. Do not propose work already covered by an existing phase. If nothing net-new remains, explain that it is already covered and do not call roadmap_phase_draft.
- Otherwise call roadmap_phase_draft with only the net-new flat peer phases. Put detail in doneWhen or sourcePrompt; never create nested phases or slices.
- A file or external source named by the user always wins over the unqualified meaning. Requests that explicitly name roadmap.md, another file path, a URL, or an external tracker are ordinary file/source work; review or edit that source as requested and do not call either Roadmap tool unless the user separately asks to add the result to our Project Notes Roadmap.
- Submit phase changes only as a draft for explicit user approval; never write phase plans into files or save Project Notes directly. After submitting, stop and say approval is pending.
- This is intent steering only. Do not start, complete, reconcile, or otherwise automate phase lifecycle changes. During work on an already-active phase, use roadmap_status only for the progress reports that work requires.
- For ordinary coding requests, do nothing Roadmap-specific.
`.trim();

export interface AppSidecarRoadmapDraftToolSession {
  getState(): { sessionId: string };
}

export interface AppSidecarRoadmapDraftToolHostDependencies {
  cwd: string;
  repository: Pick<ProjectNotesRepository, "load">;
  drafts: AppSidecarRoadmapDraftCoordinator;
  getOwningSession: () => AppSidecarRoadmapDraftToolSession;
}

/** Per-logical-session inspect-before-draft capability. */
export class AppSidecarRoadmapDraftToolHost {
  private inspectedRevision: number | null = null;
  private inspectedProjectKey: string | null = null;
  private inspectedSessionId: string | null = null;

  constructor(private readonly dependencies: AppSidecarRoadmapDraftToolHostDependencies) {}

  createSessionTools(): AgentTool[] {
    return [
      createRoadmapInspectTool(() => this.inspect()),
      createRoadmapPhaseDraftTool((request) => this.draft(request)),
    ];
  }

  async inspect(): Promise<RoadmapInspectionOutcome> {
    const loaded = await this.dependencies.repository.load(this.dependencies.cwd);
    const result = projectRoadmapInspection(this.dependencies.cwd, loaded);
    if (result.status === "ok") {
      this.inspectedProjectKey = result.inspection.projectKey;
      this.inspectedRevision = result.inspection.revision;
      this.inspectedSessionId = this.dependencies.getOwningSession().getState().sessionId;
    } else {
      this.clearInspection();
    }
    return result;
  }

  async draft(request: RoadmapPhaseDraftRequest): Promise<RoadmapPhaseDraftToolResult> {
    const projectKey = canonicalProjectKey(this.dependencies.cwd);
    const sessionId = this.dependencies.getOwningSession().getState().sessionId;
    if (
      this.inspectedProjectKey !== projectKey ||
      this.inspectedRevision === null ||
      this.inspectedSessionId !== sessionId
    ) {
      this.clearInspection();
      return { status: "inspection-required" };
    }
    if (request.expectedRevision !== this.inspectedRevision) {
      return {
        status: "inspection-revision-mismatch",
        inspectedRevision: this.inspectedRevision,
        requestedRevision: request.expectedRevision,
      };
    }

    const loaded = await this.dependencies.repository.load(this.dependencies.cwd);
    if (loaded.status === "missing") {
      this.clearInspection();
      return { status: "notes-missing" };
    }
    if (loaded.status === "corrupt") {
      this.clearInspection();
      return { status: "notes-corrupt", primary: loaded.primary, backup: loaded.backup };
    }
    if (loaded.snapshot.revision !== request.expectedRevision) {
      this.clearInspection();
      return {
        status: "stale-revision",
        expectedRevision: request.expectedRevision,
        currentRevision: loaded.snapshot.revision,
      };
    }

    const result = this.dependencies.drafts.create({
      cwd: this.dependencies.cwd,
      sessionId,
      request,
    });
    return draftToolResult(result);
  }

  private clearInspection(): void {
    this.inspectedProjectKey = null;
    this.inspectedRevision = null;
    this.inspectedSessionId = null;
  }
}

export function projectRoadmapInspection(
  cwd: string,
  loaded: ProjectNotesLoadOutcome,
): RoadmapInspectionOutcome {
  const projectKey = canonicalProjectKey(cwd);
  if (loaded.status === "missing") return { status: "missing", projectKey };
  if (loaded.status === "corrupt") {
    return {
      status: "corrupt",
      projectKey,
      primary: loaded.primary,
      backup: loaded.backup,
    };
  }
  const inspection: RoadmapInspection = {
    projectKey: loaded.snapshot.projectKey,
    revision: loaded.snapshot.revision,
    phases: [...loaded.snapshot.document.phases]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map(projectPhaseInspection),
  };
  return { status: "ok", inspection };
}

function projectPhaseInspection(phase: NotesPhase): RoadmapInspection["phases"][number] {
  const statusUpdates = phase.roadmapEvents.filter((event) => event.type === "status-update");
  const progress = statusUpdates.at(-1) ?? null;
  const verification = findLastStatusUpdate(statusUpdates, (event) => event.verification !== null);
  const review = findLastCompletionReview(phase);
  return {
    id: phase.id,
    title: phase.title,
    goal: phase.goal,
    doneWhen: [...phase.doneWhen],
    order: phase.order,
    status: phase.status,
    archivedAt: phase.archivedAt,
    hasBoundSession: phase.session !== null,
    latestProgress: progress?.progress ?? null,
    latestBlocker: progress?.blocker ?? null,
    latestVerification: verification
      ? { status: verification.verification!, reason: verification.verificationReason }
      : null,
    latestReview: review
      ? { reviewer: review.reviewer, decision: review.decision, reason: review.reason }
      : null,
    hasUserStatusOverride: phase.overrides.status !== null,
  };
}

function findLastStatusUpdate(
  updates: NotesRoadmapStatusUpdate[],
  predicate: (event: NotesRoadmapStatusUpdate) => boolean,
): NotesRoadmapStatusUpdate | null {
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const event = updates[index]!;
    if (predicate(event)) return event;
  }
  return null;
}

function findLastCompletionReview(phase: NotesPhase): NotesRoadmapCompletionReview | null {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index]!;
    if (event.type === "completion-review") return event;
  }
  return null;
}

function draftToolResult(result: RoadmapPhaseDraftCreateResult): RoadmapPhaseDraftToolResult {
  if (result.status === "drafted") return { status: "drafted", draft: result.draft };
  if (result.status === "proposal-pending") {
    return { status: "proposal-pending", draftId: result.draft.id };
  }
  return {
    status: "invalid-proposal",
    path: result.path,
    message: result.message,
  };
}
