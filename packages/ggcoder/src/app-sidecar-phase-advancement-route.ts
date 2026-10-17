import { isExactRecord, requestPathname } from "./app-sidecar-http-json.js";

export interface PhaseAdvancementStartRoute {
  checkpointId: string;
}

export interface PhaseAdvancementStartBody {
  action: "start-next-phase";
  nextPhaseId: string;
}

export function parsePhaseAdvancementStartRoute(
  method: string | undefined,
  requestUrl: string | undefined,
): PhaseAdvancementStartRoute | null {
  if (method !== "POST" || !requestUrl) return null;
  const match = /^\/notes\/roadmap\/advancement\/([^/]+)\/start$/.exec(requestPathname(requestUrl));
  if (!match) return null;
  try {
    const checkpointId = decodeURIComponent(match[1]!);
    return checkpointId.trim() ? { checkpointId } : null;
  } catch {
    return null;
  }
}

export function parsePhaseAdvancementStartBody(value: unknown): PhaseAdvancementStartBody | null {
  if (!isExactRecord(value, ["action", "nextPhaseId"])) return null;
  if (value.action !== "start-next-phase") return null;
  if (typeof value.nextPhaseId !== "string" || !value.nextPhaseId.trim()) return null;
  return { action: value.action, nextPhaseId: value.nextPhaseId };
}
