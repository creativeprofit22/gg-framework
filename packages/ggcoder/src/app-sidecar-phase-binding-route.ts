import {
  isPhaseBindingProtocolRequest,
  type PhaseBindingOutcome,
  type PhaseBindingProtocolRequest,
  type PhaseExecutionReconciliationOutcome,
  type PhaseLeaseOutcome,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import { requestPathname } from "./app-sidecar-http-json.js";

export const PHASE_BINDING_ROUTE = "/notes/roadmap/phase-binding";

export function isPhaseBindingRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): boolean {
  return method === "POST" && !!requestUrl && requestPathname(requestUrl) === PHASE_BINDING_ROUTE;
}

export function parsePhaseBindingBody(value: unknown): PhaseBindingProtocolRequest | null {
  return isPhaseBindingProtocolRequest(value) ? value : null;
}

export function phaseBindingHttpStatus(
  outcome: PhaseBindingOutcome | PhaseLeaseOutcome | PhaseExecutionReconciliationOutcome,
): number {
  switch (outcome.status) {
    case "committed":
    case "duplicate":
    case "already-bound":
    case "inspected":
    case "acquired":
    case "renewed":
    case "released":
    case "reconciled":
      return 200;
    case "phase-not-found":
    case "missing":
      return 404;
    case "corrupt":
    case "lease-corrupt":
      return 500;
    default:
      return 409;
  }
}
