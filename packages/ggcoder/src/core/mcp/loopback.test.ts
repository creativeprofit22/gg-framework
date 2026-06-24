import { describe, expect, it } from "vitest";
import { isLocalhost, alternateLoopback, isNetworkError } from "./loopback.js";

describe("isLocalhost", () => {
  it("identifies name + IPv4 + IPv6 loopback", () => {
    expect(isLocalhost(new URL("http://localhost:8931/mcp"))).toBe(true);
    expect(isLocalhost(new URL("http://127.0.0.1:8931/mcp"))).toBe(true);
    expect(isLocalhost(new URL("http://[::1]:8931/mcp"))).toBe(true);
    expect(isLocalhost(new URL("http://0.0.0.0:8931/mcp"))).toBe(true);
  });

  it("is case-insensitive on the hostname", () => {
    expect(isLocalhost(new URL("http://LOCALHOST:8931/mcp"))).toBe(true);
    expect(isLocalhost(new URL("http://LocalHost:8931/mcp"))).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLocalhost(new URL("https://mcp.notion.com/mcp"))).toBe(false);
    expect(isLocalhost(new URL("http://192.168.1.5:8931/mcp"))).toBe(false);
    expect(isLocalhost(new URL("https://example.com"))).toBe(false);
  });
});

describe("alternateLoopback", () => {
  it("maps localhost → 127.0.0.1 (the Windows IPv6-first case)", () => {
    expect(alternateLoopback("localhost")).toBe("127.0.0.1");
  });

  it("maps 127.0.0.1 → localhost (server bound to ::1 case)", () => {
    expect(alternateLoopback("127.0.0.1")).toBe("localhost");
  });

  it("maps ::1 → 127.0.0.1", () => {
    expect(alternateLoopback("::1")).toBe("127.0.0.1");
  });

  it("maps 0.0.0.0 → 127.0.0.1", () => {
    expect(alternateLoopback("0.0.0.0")).toBe("127.0.0.1");
  });

  it("is case-insensitive", () => {
    expect(alternateLoopback("LOCALHOST")).toBe("127.0.0.1");
    expect(alternateLoopback("LocalHost")).toBe("127.0.0.1");
  });

  it("returns undefined for non-loopback (no retry to attempt)", () => {
    expect(alternateLoopback("mcp.notion.com")).toBeUndefined();
    expect(alternateLoopback("192.168.1.5")).toBeUndefined();
    expect(alternateLoopback("")).toBeUndefined();
  });
});

describe("isNetworkError", () => {
  it("detects Node fetch ECONNREFUSED (cause.code)", () => {
    const err = new TypeError("fetch failed");
    (err as { cause: unknown }).cause = {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED ::1:8931",
    };
    expect(isNetworkError(err)).toBe(true);
  });

  it("detects plain ECONNREFUSED message", () => {
    expect(isNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:8931"))).toBe(true);
  });

  it("detects ECONNRESET", () => {
    const err = new Error("something");
    (err as { cause: unknown }).cause = { code: "ECONNRESET" };
    expect(isNetworkError(err)).toBe(true);
  });

  it("detects SSE transport error (SseError has 'sse error' in message)", () => {
    expect(isNetworkError(new Error("SSE error: Connection refused"))).toBe(true);
    expect(isNetworkError(new Error("sse error: stream closed"))).toBe(true);
  });

  it("detects browser-style 'Failed to fetch'", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("Network request failed"))).toBe(true);
  });

  it("detects ENOTFOUND (DNS resolution failure)", () => {
    const err = new TypeError("fetch failed");
    (err as { cause: unknown }).cause = { code: "ENOTFOUND" };
    expect(isNetworkError(err)).toBe(true);
  });

  it("does NOT flag protocol/auth errors (retry won't help)", () => {
    expect(isNetworkError(new Error("Server returned 401 after successful authentication"))).toBe(
      false,
    );
    expect(isNetworkError(new Error("Unauthorized"))).toBe(false);
    expect(isNetworkError(new Error("Streamable HTTP error: Error POSTing to endpoint"))).toBe(
      false,
    );
    expect(isNetworkError(new Error("Server's protocol version is not supported"))).toBe(false);
    expect(isNetworkError(new Error("Too Many Requests"))).toBe(false);
  });

  it("handles null/undefined/strings gracefully", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError("some string")).toBe(false);
    expect(isNetworkError("ECONNREFUSED in a plain string")).toBe(true);
  });
});
