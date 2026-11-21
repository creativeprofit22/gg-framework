import type http from "node:http";
import type { AgentSession } from "./core/agent-session.js";
import { captureSidecarError } from "./core/sidecar-error-reporter.js";
import { json, readBody } from "./app-sidecar/http.js";
import { AppSidecarJsonBodyError, readJsonBody } from "./app-sidecar-http-json.js";
import type { AppSidecarNotesHandler } from "./app-sidecar-notes.js";
import type { AppSidecarPhaseBindingService } from "./app-sidecar-phase-binding.js";
import {
  isPhaseBindingRoute,
  parsePhaseBindingBody,
  phaseBindingHttpStatus,
} from "./app-sidecar-phase-binding-route.js";
import type { PhaseStartResponseBody } from "./app-sidecar-phase-launch.js";
import { handlePhaseStartRoute, parsePhaseStartBody } from "./app-sidecar-phase-route.js";
import type { AppSidecarReminderHandler } from "./app-sidecar-reminders.js";
import {
  type AppSidecarRoadmapDraftDecisionService,
  parseRoadmapPhaseDraftRejectBody,
  parseRoadmapPhaseDraftRoute,
  roadmapPhaseDraftApprovalHttpStatus,
  roadmapPhaseDraftRejectionHttpStatus,
} from "./app-sidecar-roadmap-draft-route.js";

/**
 * Per-session Roadmap/Notes HTTP routes (Local Fork). `getSession` is read at
 * every use so a swapped session is honoured exactly like the former inline
 * route bodies inside the per-session `handle()`.
 */
interface AppSidecarRoadmapSessionRoutesDeps {
  cwd: string;
  logicalSessionId: string;
  host: string;
  mode: string;
  getSession: () => AgentSession;
  phaseBinding: AppSidecarPhaseBindingService;
  notes: AppSidecarNotesHandler;
  reminders: AppSidecarReminderHandler;
  roadmapDraftDecisions: AppSidecarRoadmapDraftDecisionService;
  startRoadmapPhase: (
    phaseId: string,
    respond: (status: number, body: PhaseStartResponseBody) => void,
    confirmedPrerequisiteIds?: readonly string[],
  ) => Promise<void>;
}

interface AppSidecarRoadmapSessionRoutes {
  /** Phase binding, Notes, reminders and Roadmap phase-draft routes. */
  handleNotesRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): boolean;
  /** `POST /phases/:id/start`. */
  handlePhaseStartRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): boolean;
}

export function createAppSidecarRoadmapSessionRoutes(
  deps: AppSidecarRoadmapSessionRoutesDeps,
): AppSidecarRoadmapSessionRoutes {
  const {
    cwd,
    logicalSessionId,
    host,
    mode,
    getSession,
    phaseBinding,
    notes,
    reminders,
    roadmapDraftDecisions,
    startRoadmapPhase,
  } = deps;

  function handleNotesRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): boolean {
    if (isPhaseBindingRoute(method, url)) {
      if (mode !== "code") {
        json(res, 403, { status: "coding-mode-required" });
        return true;
      }
      void readJsonBody(req, 64 * 1024)
        .then((body) => {
          const request = parsePhaseBindingBody(body);
          if (!request) {
            json(res, 400, { status: "invalid-request" });
            return;
          }
          const binding =
            request.version === 3
              ? phaseBinding.reconcilePhaseExecution(request, getSession())
              : request.version === 2
                ? phaseBinding.lease(request, getSession())
                : phaseBinding.bind(request, getSession());
          return binding.then((outcome) => {
            json(res, phaseBindingHttpStatus(outcome), outcome);
          });
        })
        .catch((error) => {
          if (error instanceof AppSidecarJsonBodyError) {
            json(res, error.kind === "too-large" ? 413 : 400, { status: "invalid-request" });
            return;
          }
          captureSidecarError(error, "app-sidecar.phase-binding");
          json(res, 500, { status: "failed" });
        });
      return true;
    }

    const sessionState = getSession().getState();
    if (
      notes.handle(
        req,
        res,
        {
          cwd,
          logicalSessionId,
          currentSession: {
            sessionId: sessionState.sessionId,
            sessionPath: sessionState.sessionPath,
          },
          activePhaseContext: getSession().getActivePhaseContext(),
        },
        url,
        method,
      )
    ) {
      return true;
    }
    if (reminders.handle(req, res, { id: logicalSessionId, cwd }, url, method)) return true;

    const draftRoute = parseRoadmapPhaseDraftRoute(method, url);
    if (draftRoute.status === "invalid-path") {
      json(res, 400, { error: "invalid draft id" });
      return true;
    }
    if (draftRoute.status === "matched") {
      if (draftRoute.route.action === "pending") {
        json(res, 200, { status: "ok", draft: roadmapDraftDecisions.pending(cwd) });
        return true;
      }
      if (draftRoute.route.action === "approve") {
        void roadmapDraftDecisions
          .approve(cwd, draftRoute.route.draftId)
          .then((result) => json(res, roadmapPhaseDraftApprovalHttpStatus(result), result))
          .catch((error) => {
            captureSidecarError(error, "app-sidecar.roadmap-draft.approve");
            json(res, 500, { status: "storage-failed", message: "phase creation failed" });
          });
        return true;
      }
      const draftId = draftRoute.route.draftId;
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          const parsed = parseRoadmapPhaseDraftRejectBody(raw);
          if (parsed.status === "invalid") {
            json(res, 422, { error: parsed.message });
            return;
          }
          const result = await roadmapDraftDecisions.reject(cwd, draftId, parsed.feedback);
          json(res, roadmapPhaseDraftRejectionHttpStatus(result), result);
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.roadmap-draft.reject");
          json(res, 500, { error: "phase rejection failed" });
        });
      return true;
    }
    return false;
  }

  function handlePhaseStartRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): boolean {
    if (
      handlePhaseStartRoute({
        method,
        url,
        host,
        respond: (status, body) => json(res, status, body),
        start: (phaseId) => {
          void (async () => {
            let body: ReturnType<typeof parsePhaseStartBody> = null;
            try {
              body = parsePhaseStartBody(await readJsonBody(req, 64 * 1024));
            } catch (error) {
              if (!(error instanceof AppSidecarJsonBodyError)) throw error;
            }
            if (!body) {
              json(res, 400, {
                status: "failed",
                code: "launch-failed",
                operationId: null,
                message: "The phase start request was invalid.",
              } satisfies PhaseStartResponseBody);
              return;
            }
            await startRoadmapPhase(
              phaseId,
              (status, responseBody) => json(res, status, responseBody),
              body.confirmedPrerequisiteIds,
            );
          })().catch((error: unknown) => {
            captureSidecarError(error, "app-sidecar.phase.start");
            if (res.headersSent) return;
            json(res, 500, {
              status: "failed",
              code: "launch-failed",
              operationId: null,
              message: "Phase launch failed. Retry Start phase.",
            } satisfies PhaseStartResponseBody);
          });
        },
      })
    ) {
      return true;
    }
    return false;
  }

  return { handleNotesRoutes, handlePhaseStartRoutes };
}
