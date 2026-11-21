import type { PhaseStartResult } from "@kenkaiiii/gg-core/phase-start-protocol";

export interface PhaseStartRouteDependencies {
  method: string;
  url: string;
  host: string;
  respond(status: number, body: PhaseStartResult): void;
  start(phaseId: string): void;
}

export interface PhaseStartBody {
  confirmedPrerequisiteIds: string[];
}

const CONFIRMED_PREREQUISITES_MAX_ITEMS = 200;
const PHASE_ID_MAX_LENGTH = 512;

/** Accepts exactly `{ confirmedPrerequisiteIds: string[] }`; anything else is invalid. */
export function parsePhaseStartBody(body: unknown): PhaseStartBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "confirmedPrerequisiteIds") return null;
  const ids = (body as { confirmedPrerequisiteIds: unknown }).confirmedPrerequisiteIds;
  if (
    !Array.isArray(ids) ||
    ids.length > CONFIRMED_PREREQUISITES_MAX_ITEMS ||
    !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= PHASE_ID_MAX_LENGTH)
  ) {
    return null;
  }
  return { confirmedPrerequisiteIds: [...(ids as string[])] };
}

/** Handles only POST /phases/:phaseId/start and leaves every other route untouched. */
export function handlePhaseStartRoute(dependencies: PhaseStartRouteDependencies): boolean {
  const pathname = new URL(dependencies.url, `http://${dependencies.host}`).pathname;
  const match = pathname.match(/^\/phases\/([^/]+)\/start$/);
  if (dependencies.method !== "POST" || !match) return false;

  let phaseId: string;
  try {
    phaseId = decodeURIComponent(match[1]!);
  } catch {
    dependencies.respond(400, {
      status: "failed",
      code: "invalid-phase-id",
      operationId: null,
      message: "The phase identifier is malformed.",
    } satisfies PhaseStartResult);
    return true;
  }

  dependencies.start(phaseId);
  return true;
}
