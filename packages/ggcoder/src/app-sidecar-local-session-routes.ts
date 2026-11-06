import type http from "node:http";
import type { ContinuationCommitResponse } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { AgentSession } from "./core/agent-session.js";
import { CONTINUATION_HANDOFF_LIMITS } from "./core/continuation-handoff.js";
import { captureSidecarError } from "./core/sidecar-error-reporter.js";
import { readCappedBody } from "./utils/http-body.js";
import { json, readBody } from "./app-sidecar/http.js";
import {
  type AppSidecarContinuationSession,
  parseContinuationCommitRequest,
} from "./app-sidecar-continuation-session.js";
import {
  type AppSidecarDecisionSummaryService,
  DECISION_SUMMARY_CONTEXT_MAX_BYTES,
} from "./app-sidecar-decision-summary.js";
import { handleDecisionSummaryRequest } from "./app-sidecar-decision-summary-route.js";

/**
 * Per-session Local Fork routes for decision summaries and continuation
 * handoff. `getSession` is read at every use so a
 * swapped session is honoured exactly like the former inline route bodies
 * inside the per-session `handle()`.
 */
interface AppSidecarLocalSessionRoutesDeps {
  getSession: () => AgentSession;
  decisionSummaryService: AppSidecarDecisionSummaryService;
  continuationSession: AppSidecarContinuationSession;
}

interface AppSidecarLocalSessionRoutes {
  /** `POST /decision-summary`, `/continuation-handoff`, `/continuation-commit`. */
  handleSessionToolRoutes: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => boolean;
}

export function createAppSidecarLocalSessionRoutes(
  deps: AppSidecarLocalSessionRoutesDeps,
): AppSidecarLocalSessionRoutes {
  const { getSession, decisionSummaryService, continuationSession } = deps;

  function handleSessionToolRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): boolean {
    if (method === "POST" && url === "/decision-summary") {
      void readCappedBody(req, res, DECISION_SUMMARY_CONTEXT_MAX_BYTES)
        .then(async (raw) => {
          if (raw === null) return;
          const response = await handleDecisionSummaryRequest(
            raw,
            getSession(),
            decisionSummaryService,
          );
          json(res, response.status, response.body);
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.decision-summary.route");
          json(res, 500, { error: "decision summary unavailable" });
        });
      return true;
    }

    if (method === "POST" && url === "/continuation-handoff") {
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          let nextInstruction: string;
          try {
            const body = JSON.parse(raw) as { nextInstruction?: unknown };
            nextInstruction = typeof body.nextInstruction === "string" ? body.nextInstruction : "";
          } catch {
            json(res, 400, { error: "invalid JSON body" });
            return;
          }
          if (!nextInstruction.trim()) {
            json(res, 400, { error: "empty next instruction" });
            return;
          }
          if (nextInstruction.length > CONTINUATION_HANDOFF_LIMITS.nextInstructionChars) {
            json(res, 413, { error: "next instruction is too long" });
            return;
          }
          try {
            const prepared = await continuationSession.prepare(nextInstruction);
            json(res, 200, prepared);
          } catch (error) {
            captureSidecarError(error, "app-sidecar.continuation-handoff");
            json(res, 502, {
              error: error instanceof Error ? error.message : "continuation handoff failed",
            });
          }
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.continuation-handoff.route");
          json(res, 500, { error: "continuation handoff failed" });
        });
      return true;
    }

    if (method === "POST" && url === "/continuation-commit") {
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            body = null;
          }
          const request = parseContinuationCommitRequest(body);
          if (!request) {
            json(res, 400, {
              operationId: "",
              preparedId: "",
              outcome: "rejected",
              accepted: false,
              resetAttempted: false,
              error: "invalid_continuation_commit",
              message: "Expected preparedId, operationId and optional profile only.",
            } satisfies ContinuationCommitResponse);
            return;
          }
          const result = await continuationSession.commit(request);
          json(res, result.status, result.body);
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.continuation-commit");
          if (!res.headersSent)
            json(res, 500, {
              operationId: "",
              preparedId: "",
              outcome: "outcome-unknown",
              accepted: null,
              resetAttempted: true,
              error: "continuation_outcome_unknown",
              message: "Inspect the current session. Do not automatically reset or resend.",
            } satisfies ContinuationCommitResponse);
        });
      return true;
    }
    return false;
  }

  return { handleSessionToolRoutes };
}
