import type { FloorAgent } from "./critter-floor";
import { CRITTERS } from "./critter-sprites";

/** Every critter, as an always-busy pretend agent so it stays out and plays. */
export function homeRoster(): FloorAgent[] {
  return CRITTERS.map((critter): FloorAgent => ({
    key: `home:${critter.id}`,
    agentName: undefined,
    critterId: critter.id,
    label: critter.name,
    status: "running",
    activity: undefined,
    tokens: null,
    durationMs: undefined,
    toolUseCount: 0,
  }));
}
