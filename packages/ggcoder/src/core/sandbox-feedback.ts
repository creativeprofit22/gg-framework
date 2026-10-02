/**
 * Turn raw OS-sandbox denials into guidance the model can act on.
 *
 * A blocked command otherwise surfaces as inscrutable tool noise ("CONNECT
 * tunnel failed, response 403", "Operation not permitted"), which the model
 * tends to retry verbatim. Naming the boundary and the one-step fix is what
 * turns a dead end into a recoverable turn.
 */

/** SRT's proxy rejection, plus how common clients report it. */
const NETWORK_DENIAL = [
  "blocked-by-allowlist",
  "Connection blocked by network allowlist",
  "CONNECT tunnel failed, response 403",
];

const FILESYSTEM_DENIAL = ["Operation not permitted", "operation not permitted", "EPERM"];

/** Hosts the command tried to reach, best-effort, for a precise suggestion. */
function extractHosts(output: string): string[] {
  const hosts = new Set<string>();
  const patterns = [
    /(?:CONNECT|to)\s+([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi,
    /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const host = match[1]?.toLowerCase();
      if (host && !host.endsWith(".local")) hosts.add(host);
    }
  }
  return [...hosts].slice(0, 3);
}

export interface SandboxDenialNote {
  kind: "network" | "filesystem";
  note: string;
}

/**
 * Inspect finished command output for a sandbox denial.
 *
 * @param output   Combined stdout/stderr as returned to the model.
 * @param sandboxed Whether this command actually ran isolated.
 */
export function describeSandboxDenial(
  output: string,
  sandboxed: boolean,
): SandboxDenialNote | null {
  if (!sandboxed || !output) return null;

  if (NETWORK_DENIAL.some((marker) => output.includes(marker))) {
    const hosts = extractHosts(output);
    const target = hosts.length > 0 ? hosts.join(", ") : "that host";
    return {
      kind: "network",
      note:
        `\n\n[Sandbox] Network blocked: ${target} is not an approved destination. ` +
        `Common package registries and git hosts are approved already, so double-check the ` +
        `address first. If the user genuinely needs it, ask them to add it under ` +
        `Settings → Command safety → Approved sites (or turn command safety off).`,
    };
  }

  if (FILESYSTEM_DENIAL.some((marker) => output.includes(marker))) {
    return {
      kind: "filesystem",
      note:
        `\n\n[Sandbox] Write blocked: that path is either outside this project or a ` +
        `protected file (.env). Prefer a path inside the project, or use the write ` +
        `tool if the user asked for that exact file. If they genuinely need shell ` +
        `writes elsewhere, ask them to enable Settings → Command safety → Allow ` +
        `changes outside the project.`,
    };
  }

  return null;
}

/** Append the denial note to command output when one applies. */
export function annotateSandboxDenial(output: string, sandboxed: boolean): string {
  const denial = describeSandboxDenial(output, sandboxed);
  return denial ? `${output}${denial.note}` : output;
}
