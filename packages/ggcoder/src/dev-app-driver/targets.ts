import { assertDeadline, systemClock, type DriverClock } from "./clock.js";
import { DevCdpClient } from "./control-client.js";

export interface DevTarget {
  id?: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

const APP_URL = /^http:\/\/(?:localhost|127\.0\.0\.1):1420(?:\/|$)/;

/** The Vite dev page on 1420; never DevTools or the WebView2 "what's new" page. */
export function isAppPageTarget(target: DevTarget): boolean {
  return (
    target.type === "page" &&
    APP_URL.test(target.url) &&
    !target.url.startsWith("devtools://") &&
    !/whatsnew/i.test(target.url)
  );
}

function parseTargets(value: unknown): DevTarget[] {
  if (!Array.isArray(value)) throw new Error("dev app target list is not an array");
  const targets: DevTarget[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, type, url, title, webSocketDebuggerUrl } = entry as Record<string, unknown>;
    if (
      typeof type !== "string" ||
      typeof url !== "string" ||
      typeof webSocketDebuggerUrl !== "string"
    )
      continue;
    targets.push({
      type,
      url,
      webSocketDebuggerUrl,
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof title === "string" ? { title } : {}),
    });
  }
  return targets;
}

export async function listTargets(
  port: number,
  { fetch = globalThis.fetch, signal }: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<DevTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, signal ? { signal } : {});
  if (!response.ok) throw new Error(`dev app target list returned ${response.status}`);
  return parseTargets(await response.json());
}

export class AmbiguousTargetError extends Error {
  override name = "AmbiguousTargetError";
}

export interface FindAppTargetOptions {
  accept?: (target: DevTarget) => boolean;
  deadlineMs?: number;
  pollMs?: number;
  clock?: DriverClock;
  fetch?: FetchLike;
  /** Called before every poll; throw to stop waiting (for example, the launched app exited). */
  check?: () => void;
}

/** Waits for exactly one matching window target; more than one is an error, not a guess. */
export async function findAppTarget(
  port: number,
  {
    accept = isAppPageTarget,
    deadlineMs = 120_000,
    pollMs = 150,
    clock = systemClock,
    fetch = globalThis.fetch,
    check,
  }: FindAppTargetOptions = {},
): Promise<DevTarget> {
  assertDeadline("deadlineMs", deadlineMs);
  assertDeadline("pollMs", pollMs);
  const deadline = clock.now() + deadlineMs;
  let lastProblem = "no debugging endpoint answered";
  while (clock.now() < deadline) {
    check?.();
    const remaining = deadline - clock.now();
    try {
      const targets = await listTargets(port, {
        fetch,
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, remaining))),
      });
      const matches = targets.filter(accept);
      if (matches.length > 1) {
        throw new AmbiguousTargetError(
          `${matches.length} dev app targets match; refusing to guess (${matches.map((t) => t.url).join(", ")})`,
        );
      }
      const [match] = matches;
      if (match) return match;
      lastProblem = `${targets.length} targets listed, none matched`;
    } catch (error) {
      if (error instanceof AmbiguousTargetError) throw error;
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    const wait = Math.min(pollMs, deadline - clock.now());
    if (wait > 0) await clock.sleep(wait);
  }
  check?.();
  throw new Error(`No dev app target on port ${port} within ${deadlineMs} ms (${lastProblem})`);
}

type LegacyWaitFor = (
  label: string,
  check: () => Promise<DevTarget | null | undefined>,
) => Promise<DevTarget>;

/** First-match legacy helper kept for existing smokes; new code should use findAppTarget. */
export async function connectToDevWebview(
  cdpPort: number,
  waitFor: LegacyWaitFor,
  acceptTarget: (candidate: DevTarget) => boolean = (candidate) =>
    !String(candidate.url).startsWith("devtools://"),
): Promise<DevCdpClient> {
  const target = await waitFor("dev fixture debugging target", async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const targets = parseTargets(await response.json());
    return targets.find((candidate) => candidate.type === "page" && acceptTarget(candidate));
  });
  return DevCdpClient.connect(target.webSocketDebuggerUrl);
}
