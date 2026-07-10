import type http from "node:http";

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
    host = "127.0.0.1",
  ): string | null {
    const header = req.headers["x-gg-session"];
    if (typeof header === "string" && header.length > 0) return header;
    if (Array.isArray(header) && header[0]) return header[0];
    try {
      return new URL(requestUrl, `http://${host}`).searchParams.get("session");
    } catch {
      return null;
    }
  }

  resolveRequest(
    req: Pick<http.IncomingMessage, "headers">,
    requestUrl: string,
    host = "127.0.0.1",
  ): TContext | undefined {
    const sessionId = this.sessionIdFromRequest(req, requestUrl, host);
    return sessionId ? this.get(sessionId) : undefined;
  }

  take(sessionId: string): TContext | undefined {
    const context = this.#sessions.get(sessionId);
    if (context) this.#sessions.delete(sessionId);
    return context;
  }

  async deleteAndDispose(sessionId: string): Promise<boolean> {
    const context = this.take(sessionId);
    if (!context) return false;
    await context.dispose();
    return true;
  }

  async disposeAll(): Promise<void> {
    const contexts = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(contexts.map((context) => Promise.resolve(context.dispose())));
  }
}
