import { describe, expect, it } from "vitest";
import { isTransportFailure } from "./agent-loop.js";

/**
 * Regression for the bare-text SDK timeout (#28).
 *
 * `APIConnectionTimeoutError` — thrown by both the Anthropic and OpenAI SDKs —
 * carries no errno and no undici code, only the message "Request timed out.",
 * and does not even set `name` (it stays the default "Error"; only
 * `constructor.name` identifies the class). So it fell through every branch of
 * `isTransportFailure` and surfaced raw to the user instead of retrying like
 * every other transient transport failure. The Anthropic client is built with
 * `maxRetries: 0`, so the agent loop is the only retry layer.
 *
 * The error is replicated structurally rather than imported: gg-agent depends
 * only on gg-ai and zod, and pulling a provider SDK in as a devDependency to
 * construct one object is not worth the coupling. Values below are copied from
 * the real classes (@anthropic-ai/sdk 0.94.0 core/error.js:86, openai 6.34.0
 * core/error.js:88).
 */
function sdkTimeoutError(): Error {
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  return new APIConnectionTimeoutError("Request timed out.");
}

/** An SDK APIError for a permanent 4xx, which carries `status` but no `code`. */
function sdkStatusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("isTransportFailure on timeouts without an error code", () => {
  it("classifies the provider SDK's own timeout error", () => {
    const err = sdkTimeoutError();

    // Guards the assumptions the fix rests on.
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as { status?: unknown }).status).toBeUndefined();
    expect(err.name).toBe("Error");

    expect(isTransportFailure(err)).toBe(true);
  });

  it("classifies a request-scoped timeout message", () => {
    expect(isTransportFailure(new Error("Request to Anthropic timed out"))).toBe(true);
  });

  // AbortSignal.timeout() rejects with a DOMException whose `code` is the
  // numeric legacy constant (23), not a string — so only `name` identifies it.
  it("classifies an AbortSignal.timeout() rejection", () => {
    const err = new DOMException("The operation was aborted", "TimeoutError");
    expect(typeof (err as unknown as { code: unknown }).code).toBe("number");
    expect(isTransportFailure(err)).toBe(true);
  });

  it("classifies a timeout nested in a cause chain", () => {
    const err = new Error("stream failed", { cause: sdkTimeoutError() });
    expect(isTransportFailure(err)).toBe(true);
  });

  // A 4xx is a permanent client error. Retrying it five times with backoff
  // burns the user's time and money and cannot succeed, so a timeout-shaped
  // message must not override the status.
  it("does not retry a 4xx that merely mentions a timeout", () => {
    expect(isTransportFailure(sdkStatusError(400, "Request timed out."))).toBe(false);
  });

  // 5xx timeouts are transient and DO belong on the retry path.
  it("still retries a 5xx timeout", () => {
    expect(isTransportFailure(sdkStatusError(504, "Request timed out."))).toBe(true);
  });

  it("does not retry unrelated errors that merely contain the word timeout", () => {
    expect(isTransportFailure(new Error("Set the timeout option to a positive number"))).toBe(
      false,
    );
    expect(isTransportFailure(new Error("tool 'bash' timed out after 120s"))).toBe(false);
  });
});
