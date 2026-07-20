import { ProviderError } from "../errors.js";
import type { Message, StreamEvent, StreamOptions, StreamResponse, Usage } from "../types.js";
import { StreamResult } from "../utils/event-stream.js";
import { readSseStream } from "../utils/sse.js";

interface AzureInputMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AzureCompletedResponse {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

export function streamAzureOpenAIResponses(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const apiKey = requireOption(options.apiKey, "apiKey");
  const model = requireOption(options.model, "model");
  const url = parseResponsesUrl(requireOption(options.baseUrl, "baseUrl"));
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        input: toAzureInput(options.messages),
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (cause) {
    throw new ProviderError("azure", "Azure OpenAI request failed.", { cause });
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new ProviderError(
      "azure",
      extractSafeErrorMessage(responseText, response.status, apiKey),
      { statusCode: response.status },
    );
  }

  if (!response.body) {
    throw new ProviderError("azure", "Azure OpenAI returned an empty response stream.");
  }

  let accumulatedText = "";
  let completedResponse: AzureCompletedResponse | undefined;
  let sawEvent = false;

  try {
    for await (const sseEvent of readSseStream(response.body)) {
      const data = sseEvent.data.trim();
      if (!data || data === "[DONE]") continue;
      sawEvent = true;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch (cause) {
        throw new ProviderError("azure", "Azure OpenAI returned a malformed response stream.", {
          cause,
        });
      }

      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string") {
          throw new ProviderError("azure", "Azure OpenAI returned a malformed response stream.");
        }
        accumulatedText += event.delta;
        yield { type: "text_delta", text: event.delta };
      } else if (event.type === "response.completed") {
        completedResponse = asCompletedResponse(event.response);
      } else {
        const streamError = toStreamProviderError(event, apiKey);
        if (streamError) throw streamError;
      }
    }
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError("azure", "Azure OpenAI response stream failed.", { cause });
  }

  if (!sawEvent) {
    throw new ProviderError("azure", "Azure OpenAI returned an empty response stream.");
  }
  if (!completedResponse) {
    throw new ProviderError(
      "azure",
      "Azure OpenAI response stream ended before response.completed.",
    );
  }

  const stopReason = "end_turn" as const;
  const streamResponse: StreamResponse = {
    message: { role: "assistant", content: accumulatedText },
    stopReason,
    usage: toUsage(completedResponse.usage),
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

function requireOption(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new ProviderError("azure", `Azure OpenAI requires StreamOptions.${name}.`);
  }
  return value;
}

function parseResponsesUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ProviderError("azure", "Azure OpenAI baseUrl must be a valid HTTPS v1 URL.", {
      cause,
    });
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (pathname !== "/openai/v1" && !pathname.endsWith("/responses"))
  ) {
    throw new ProviderError(
      "azure",
      "Azure OpenAI baseUrl must be an HTTPS /openai/v1 base URL or full Responses URL without credentials or a fragment.",
    );
  }

  if (pathname === "/openai/v1") url.pathname = `${pathname}/responses`;
  return url.toString();
}

function toAzureInput(messages: Message[]): AzureInputMessage[] {
  const input: AzureInputMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;

    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (content) input.push({ role: message.role, content });
  }

  return input;
}

function asCompletedResponse(value: unknown): AzureCompletedResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("azure", "Azure OpenAI returned a malformed response stream.");
  }
  return value as AzureCompletedResponse;
}

function toStreamProviderError(
  event: Record<string, unknown>,
  credential: string,
): ProviderError | undefined {
  if (event.type === "error") {
    const error = objectValue(event.error);
    const message = sanitizeErrorMessage(
      stringValue(error?.message) ?? stringValue(event.message),
      credential,
    );
    const statusCode = streamErrorStatus(
      stringValue(error?.type) ?? stringValue(error?.code) ?? stringValue(event.code),
    );
    return new ProviderError("azure", message ?? "Azure OpenAI stream returned an error.", {
      ...(statusCode ? { statusCode } : {}),
    });
  }

  if (event.type === "response.failed") {
    const response = objectValue(event.response);
    const error = objectValue(response?.error);
    const message = sanitizeErrorMessage(stringValue(error?.message), credential);
    const statusCode = streamErrorStatus(stringValue(error?.code));
    return new ProviderError("azure", message ?? "Azure OpenAI response failed.", {
      ...(statusCode ? { statusCode } : {}),
    });
  }

  if (event.type === "response.incomplete") {
    const response = objectValue(event.response);
    const details = objectValue(response?.incomplete_details);
    const reason = sanitizeErrorMessage(stringValue(details?.reason), credential);
    return new ProviderError(
      "azure",
      reason
        ? `Azure OpenAI response was incomplete: ${reason}.`
        : "Azure OpenAI response was incomplete.",
    );
  }

  return undefined;
}

function streamErrorStatus(type: string | undefined): number | undefined {
  switch (type) {
    case "too_many_requests":
      return 429;
    case "forbidden":
      return 403;
    case "user_error":
      return 400;
    case "server_error":
      return 500;
    default:
      return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toUsage(usage: AzureCompletedResponse["usage"]): Usage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cachedTokens),
    outputTokens: usage?.output_tokens ?? 0,
    ...(cachedTokens > 0 ? { cacheRead: cachedTokens } : {}),
  };
}

function extractSafeErrorMessage(body: string, status: number, apiKey: string): string {
  let candidate: string | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      candidate =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? stringValue((nested as Record<string, unknown>).message)
          : stringValue(record.message);
    }
  } catch {
    if (!/<(?:!doctype|html|body|script|style)\b/i.test(body)) candidate = body;
  }

  return sanitizeErrorMessage(candidate, apiKey) || `Azure OpenAI returned HTTP ${status}.`;
}

function sanitizeErrorMessage(value: string | undefined, credential: string): string | undefined {
  return value
    ?.replaceAll(credential, "[REDACTED]")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
