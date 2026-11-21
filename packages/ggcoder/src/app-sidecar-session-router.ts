import type http from "node:http";
import { redactValue } from "@kenkaiiii/gg-ai";

export interface DisposableSessionContext {
  dispose: () => void | Promise<void>;
}

export interface SessionEventFrame {
  sessionId: string;
  type: string;
  data: unknown;
}

export function sessionEventFrame(
  sessionId: string,
  type: string,
  data: unknown,
): SessionEventFrame {
  return { sessionId, type, data };
}

export function sessionEventSseData(sessionId: string, type: string, data: unknown): string {
  return `data: ${JSON.stringify(sessionEventFrame(sessionId, type, data))}\n\n`;
}

export function redactedSessionEventSseData(
  sessionId: string,
  type: string,
  data: unknown,
  secrets: readonly string[],
): string {
  // The pane rejects a cut-off Notes snapshot, so Notes skip the size caps (secrets are still redacted).
  const limits =
    type === "notes_change"
      ? { maxEntries: Number.POSITIVE_INFINITY, maxDepth: Number.POSITIVE_INFINITY }
      : {};
  const safePayload = redactValue(sessionEventFrame(sessionId, type, data), { secrets, ...limits });
  return `data: ${JSON.stringify(safePayload)}\n\n`;
}

/** Owns daemon-session identity, request selection, and disposal semantics. */
export class AppSidecarSessionRouter<TContext extends DisposableSessionContext> {
  readonly #sessions = new Map<string, TContext>();

  add(sessionId: string, context: TContext): void {
    if (!sessionId) throw new Error("session id must not be empty");
    if (this.#sessions.has(sessionId)) throw new Error(`duplicate session: ${sessionId}`);
    this.#sessions.set(sessionId, context);
  }

  get(sessionId: string): TContext | undefined {
    return this.#sessions.get(sessionId);
  }

  values(): IterableIterator<TContext> {
    return this.#sessions.values();
  }

  entries(): IterableIterator<[string, TContext]> {
    return this.#sessions.entries();
  }

  sessionIdFromRequest(
    req: Pick<http.IncomingMessage, "headers">,
    requestUrl: string,
    options: { allowQuery?: boolean; host?: string } = {},
  ): string | null {
    const header = req.headers["x-gg-session"];
    const headerValue = typeof header === "string" ? header : header?.[0];
    const normalizedHeader = headerValue?.trim();
    if (normalizedHeader) return normalizedHeader;
    if (!options.allowQuery) return null;
    try {
      const queryValue = new URL(
        requestUrl,
        `http://${options.host ?? "127.0.0.1"}`,
      ).searchParams.get("session");
      return queryValue?.trim() || null;
    } catch {
      return null;
    }
  }

  resolveRequest(
    req: Pick<http.IncomingMessage, "headers">,
    requestUrl: string,
    options: { allowQuery?: boolean; host?: string } = {},
  ): TContext | undefined {
    const sessionId = this.sessionIdFromRequest(req, requestUrl, options);
    return sessionId ? this.get(sessionId) : undefined;
  }

  take(sessionId: string): TContext | undefined {
    const context = this.#sessions.get(sessionId);
    if (context) this.#sessions.delete(sessionId);
    return context;
  }

  /** Check and remove in one synchronous step, so nothing can reach the session in between. */
  takeIf(sessionId: string, predicate: (context: TContext) => boolean): TContext | undefined {
    const context = this.#sessions.get(sessionId);
    if (!context || !predicate(context)) return undefined;
    this.#sessions.delete(sessionId);
    return context;
  }

  async disposeTaken(context: TContext): Promise<void> {
    await context.dispose();
  }

  async deleteAndDispose(sessionId: string): Promise<boolean> {
    const context = this.take(sessionId);
    if (!context) return false;
    await this.disposeTaken(context);
    return true;
  }

  async disposeAll(): Promise<void> {
    const contexts = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(contexts.map((context) => Promise.resolve(context.dispose())));
  }
}
