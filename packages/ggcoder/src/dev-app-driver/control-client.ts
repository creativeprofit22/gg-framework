export interface ControlSocketEvent {
  data?: unknown;
}

/** The subset of a browser-style WebSocket the control client needs (fakeable in tests). */
export interface ControlSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: ControlSocketEvent) => void,
    options?: { once?: boolean },
  ): void;
}

export interface ControlClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
  /** Set once the target or connection is gone; reads can never succeed afterwards. */
  readonly goneReason: string | null;
  readonly whenGone: Promise<string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DevCdpClientOptions {
  requestTimeoutMs?: number;
}

export interface DevCdpConnectOptions extends DevCdpClientOptions {
  connectTimeoutMs?: number;
  createSocket?: (url: string) => ControlSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class DevCdpClient implements ControlClient {
  readonly socket: ControlSocket;
  readonly requestTimeoutMs: number;
  readonly pending = new Map<number, PendingRequest>();
  readonly whenGone: Promise<string>;
  closed = false;
  goneReason: string | null = null;
  private nextId = 1;
  private markGone: (reason: string) => void = () => {};

  constructor(socket: ControlSocket, { requestTimeoutMs = 15000 }: DevCdpClientOptions = {}) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.whenGone = new Promise<string>((resolve) => {
      this.markGone = resolve;
    });
    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.fail(new Error("invalid dev fixture debugging response"));
        return;
      }
      if (!isRecord(message)) return;
      if (message.method === "Inspector.detached" || message.method === "Inspector.targetCrashed") {
        this.fail(new Error("dev fixture debugging target detached"));
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error;
      if (isRecord(error)) pending.reject(new Error(String(error.message)));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () =>
      this.fail(new Error("dev fixture debugging connection closed")),
    );
    socket.addEventListener("error", () =>
      this.fail(new Error("dev fixture debugging connection failed")),
    );
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.goneReason = error instanceof Error ? error.message : String(error);
    this.markGone(this.goneReason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.close();
  }

  static async connect(
    webSocketUrl: string,
    {
      connectTimeoutMs = 10000,
      createSocket = (url) => new WebSocket(url),
      ...options
    }: DevCdpConnectOptions = {},
  ): Promise<DevCdpClient> {
    const socket = createSocket(webSocketUrl);
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("dev fixture debugging connection timed out"));
      }, connectTimeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("could not connect to the dev fixture"));
        },
        { once: true },
      );
    });
    return new DevCdpClient(socket, options);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("dev fixture debugging connection closed"));
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`dev fixture debugging request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!isRecord(result)) return undefined;
    const details = result.exceptionDetails;
    if (isRecord(details)) {
      const exception = isRecord(details.exception) ? details.exception : {};
      throw new Error(
        `Dev fixture evaluation failed: ${String(exception.description ?? details.text)}`,
      );
    }
    return isRecord(result.result) ? result.result.value : undefined;
  }

  close(): void {
    this.fail(new Error("dev fixture debugging connection closed"));
  }
}
