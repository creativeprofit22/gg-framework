import { Agent, fetch as undiciFetch } from "undici";

/**
 * Transport-level timeout for every LLM provider request.
 *
 * Node's built-in fetch runs on undici's default dispatcher, which aborts a
 * request after 300s without response headers (`UND_ERR_HEADERS_TIMEOUT`,
 * surfaced by the SDKs as "Request timed out.") and after 300s of silence
 * mid-body (`UND_ERR_BODY_TIMEOUT`, surfaced as "terminated"). Those caps sit
 * *below* the agent loop's own watchdogs (10min silent-thinking idle, 15min
 * thinking hard cap, 15min non-streaming thinking fallback), so they silently
 * become the real limit: a non-streaming reply that takes >5min to generate,
 * or a reasoning stream that stays quiet >5min, dies at exactly 300s on every
 * retry.
 *
 * Timeout policy belongs to the caller's AbortSignal (the agent loop's
 * watchdogs). This value is only a backstop for callers that pass no signal,
 * so it must stay above the longest agent-loop cap (15min).
 */
export const PROVIDER_TRANSPORT_TIMEOUT_MS = 30 * 60_000;

/**
 * Build a fetch whose transport timeouts are `timeoutMs` instead of undici's
 * 300s defaults. Uses undici's own `fetch` together with its `Agent` — mixing
 * an undici-package dispatcher with Node's bundled fetch is not supported
 * across undici majors.
 */
export function createProviderFetch(timeoutMs: number): typeof globalThis.fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const builtinFetch = globalThis.fetch;
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    // A host that replaced the global fetch (instrumentation, polyfills, test
    // doubles) keeps control of the transport, as it did before this existed.
    //
    // Global `Request` and `FormData` objects belong to Node's bundled undici,
    // and the package's fetch only recognises its own classes: a global
    // FormData is sent as the literal text "[object FormData]", which silently
    // broke multipart uploads (Moonshot video). Uploads are quick to answer,
    // so the 300s default timeouts are harmless for them.
    if (
      globalThis.fetch !== builtinFetch ||
      input instanceof Request ||
      init?.body instanceof FormData
    ) {
      return globalThis.fetch(input, init);
    }
    const response = await undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
    // undici's Response implements the same WHATWG interface as the global one.
    return response as unknown as Response;
  };
  // The OpenAI SDK refuses multipart uploads unless `fetch.Response` (else the
  // class of a probe response) encodes the global FormData. This fetch sends
  // global FormData through the built-in fetch above, so the global Response
  // class is the accurate answer; without it, Moonshot video uploads throw.
  return Object.assign(providerFetch, { Response: globalThis.Response });
}

/** Default fetch for provider transports when the caller supplies none. */
export const providerFetch: typeof globalThis.fetch = createProviderFetch(
  PROVIDER_TRANSPORT_TIMEOUT_MS,
);
