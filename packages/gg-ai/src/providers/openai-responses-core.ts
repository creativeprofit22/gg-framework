import { readSseStream } from "../utils/sse.js";

/** Provider-neutral shape shared by public and private Responses SSE transports. */
export type ResponsesEvent = Record<string, unknown>;

export interface ResponsesUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface ResponsesCompletedPayload extends ResponsesEvent {
  usage?: ResponsesUsagePayload;
}

export interface ParseResponsesSseOptions {
  /**
   * Providers choose their existing malformed-frame policy at the transport edge.
   * Omitting this callback preserves the Codex behavior of ignoring malformed JSON.
   */
  onMalformedJson?: (cause: unknown) => never;
}

/**
 * Decode the provider-neutral SSE envelope used by Responses APIs.
 *
 * Endpoint, terminal-event, error, and malformed-frame policy remain transport
 * concerns so extracting this parser cannot change either provider's behavior.
 */
export async function* parseResponsesSse(
  body: ReadableStream<Uint8Array>,
  options: ParseResponsesSseOptions = {},
): AsyncGenerator<ResponsesEvent> {
  for await (const event of readSseStream(body)) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") continue;

    try {
      yield JSON.parse(data) as ResponsesEvent;
    } catch (cause) {
      options.onMalformedJson?.(cause);
    }
  }
}
