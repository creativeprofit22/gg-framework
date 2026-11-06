import { afterEach, describe, expect, it, vi } from "vitest";
import { DevCdpClient, type ControlSocket, type ControlSocketEvent } from "./control-client.js";

type Listener = (event: ControlSocketEvent) => void;

class FakeSocket implements ControlSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ listener, once: options?.once === true });
    this.listeners.set(type, list);
  }

  emit(type: string, event: ControlSocketEvent = {}): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => !entry.once),
    );
    for (const { listener } of list) listener(event);
  }

  message(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

const settledWithin = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<string>((resolve) => setImmediate(() => resolve("PENDING")))]);

afterEach(() => {
  vi.useRealTimers();
});

describe("dev app control client", () => {
  it("rejects an outstanding evaluation when the target detaches without closing its socket", async () => {
    const socket = new FakeSocket();
    const client = new DevCdpClient(socket);
    const result = client.evaluate("closeWindow()").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    socket.message({ method: "Inspector.detached", params: { reason: "Render process gone." } });
    expect(await settledWithin(result)).toMatch(/detached/);
    expect(socket.closed).toBe(true);
  });

  it("bounds a silent request and clears pending work", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const client = new DevCdpClient(socket, { requestTimeoutMs: 100 });
    const result = client.send("Runtime.evaluate").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(101);
    expect(await Promise.race([result, Promise.resolve("PENDING")])).toMatch(
      /timed out.*Runtime.evaluate/,
    );
    expect(client.pending.size).toBe(0);
    expect(socket.closed).toBe(true);
  });

  it("settles pending work immediately on local close", async () => {
    const client = new DevCdpClient(new FakeSocket());
    const result = client.send("Page.captureScreenshot").catch((error: Error) => error.message);
    client.close();
    expect(await settledWithin(result)).toMatch(/closed/);
  });

  it("clears the deadline on a normal response", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const client = new DevCdpClient(socket, { requestTimeoutMs: 100 });
    const result = client.send("Runtime.evaluate");
    socket.message({ id: 1, result: { value: 42 } });
    expect(await result).toEqual({ value: 42 });
    expect(vi.getTimerCount()).toBe(0);
    expect(client.pending.size).toBe(0);
  });

  it("signals gone once, with the reason, and refuses later requests", async () => {
    const socket = new FakeSocket();
    const client = new DevCdpClient(socket);
    expect(client.goneReason).toBeNull();
    socket.message({ method: "Inspector.targetCrashed" });
    expect(await client.whenGone).toBe("dev fixture debugging target detached");
    socket.emit("close");
    expect(client.goneReason).toBe("dev fixture debugging target detached");
    await expect(client.send("Runtime.evaluate")).rejects.toThrow(/closed/);
    expect(socket.sent).toHaveLength(0);
  });

  it("returns the evaluated value and turns page exceptions into errors", async () => {
    const socket = new FakeSocket();
    const client = new DevCdpClient(socket);
    const value = client.evaluate("1 + 1");
    expect(socket.sent[0]).toMatchObject({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1", awaitPromise: true, returnByValue: true },
    });
    socket.message({ id: 1, result: { result: { value: 2 } } });
    expect(await value).toBe(2);
    const thrown = client.evaluate("boom()");
    socket.message({
      id: 2,
      result: { exceptionDetails: { exception: { description: "ReferenceError: boom" } } },
    });
    await expect(thrown).rejects.toThrow(/evaluation failed: ReferenceError: boom/);
  });

  it("connect waits for open and fails on a connection that never opens", async () => {
    const opening = new FakeSocket();
    const connected = DevCdpClient.connect("ws://x", { createSocket: () => opening });
    opening.emit("open");
    expect((await connected).socket).toBe(opening);

    vi.useFakeTimers();
    const silent = new FakeSocket();
    const pending = DevCdpClient.connect("ws://y", {
      createSocket: () => silent,
      connectTimeoutMs: 50,
    }).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toMatch(/timed out/);
    expect(silent.closed).toBe(true);
  });
});
