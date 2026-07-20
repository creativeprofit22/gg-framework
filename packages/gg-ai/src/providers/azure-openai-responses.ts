import { ProviderError } from "../errors.js";
import type {
  ContentPart,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
  Usage,
} from "../types.js";
import { StreamResult } from "../utils/event-stream.js";
import { isJsonObject } from "../utils/json.js";
import {
  parseResponsesSse,
  serializeResponsesInput,
  serializeResponsesTools,
  type ResponsesCompletedPayload,
} from "./openai-responses-core.js";

// eslint-disable-next-line no-control-regex -- Provider error text must not expose control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

interface PendingAzureToolCall {
  id: string;
  itemId?: string;
  name: string;
  args?: Record<string, unknown>;
  argumentsDone: boolean;
}

interface AzureFunctionCallItem {
  id: string;
  itemId?: string;
  name: string;
  arguments?: string;
}

export function streamAzureOpenAIResponses(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const apiKey = requireOption(options.apiKey, "apiKey");
  const model = requireOption(options.model, "model");
  const url = parseResponsesUrl(requireOption(options.baseUrl, "baseUrl"));
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const { system, input } = serializeResponsesInput(options.messages);
  const requestBody: Record<string, unknown> = { model, input, stream: true };
  if (system !== undefined) requestBody.instructions = system;
  if (options.tools?.length) {
    requestBody.tools = serializeResponsesTools(options.tools, { strict: null });
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
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
  let completedResponse: ResponsesCompletedPayload | undefined;
  let sawEvent = false;
  const toolCallsByOutputIndex = new Map<number, PendingAzureToolCall>();
  const toolCallsByItem = new Map<string, PendingAzureToolCall>();
  const toolCallOrder: PendingAzureToolCall[] = [];

  try {
    for await (const event of parseResponsesSse(response.body, {
      onMalformedJson(cause): never {
        throw new ProviderError("azure", "Azure OpenAI returned a malformed response stream.", {
          cause,
        });
      },
    })) {
      sawEvent = true;

      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string") throw malformedStreamError();
        accumulatedText += event.delta;
        yield { type: "text_delta", text: event.delta };
      } else if (event.type === "response.output_item.added") {
        const item = objectValue(event.item);
        if (item?.type === "function_call") {
          const outputIndex = parseOutputIndex(event.output_index);
          const parsedCall = parseFunctionCallItem(item, false);
          if (
            toolCallsByOutputIndex.has(outputIndex) ||
            toolCallOrder.some((toolCall) => toolCall.id === parsedCall.id)
          ) {
            throw malformedToolCallStreamError();
          }
          const toolCall: PendingAzureToolCall = {
            id: parsedCall.id,
            name: parsedCall.name,
            argumentsDone: false,
          };
          bindItemId(toolCall, parsedCall.itemId, toolCallsByItem);
          toolCallsByOutputIndex.set(outputIndex, toolCall);
          toolCallOrder.push(toolCall);
        }
      } else if (event.type === "response.function_call_arguments.delta") {
        const toolCall = findToolCall(
          event.output_index,
          event.item_id,
          toolCallsByOutputIndex,
          toolCallsByItem,
        );
        if (typeof event.delta !== "string" || toolCall.argumentsDone || toolCall.args) {
          throw malformedToolCallStreamError();
        }
        yield {
          type: "toolcall_delta",
          id: toolCall.id,
          name: toolCall.name,
          argsJson: event.delta,
        };
      } else if (event.type === "response.function_call_arguments.done") {
        const toolCall = findToolCall(
          event.output_index,
          event.item_id,
          toolCallsByOutputIndex,
          toolCallsByItem,
        );
        if (typeof event.arguments !== "string" || toolCall.argumentsDone || toolCall.args) {
          throw malformedToolCallStreamError();
        }
        toolCall.argumentsDone = true;
      } else if (event.type === "response.output_item.done") {
        const item = objectValue(event.item);
        if (item?.type === "function_call") {
          const toolCall = findToolCall(
            event.output_index,
            item.id,
            toolCallsByOutputIndex,
            toolCallsByItem,
          );
          const completedCall = parseFunctionCallItem(item, true);
          if (
            toolCall.args ||
            toolCall.id !== completedCall.id ||
            toolCall.name !== completedCall.name
          ) {
            throw malformedToolCallStreamError();
          }
          const args = parseCompleteToolArguments(completedCall.arguments!);
          toolCall.args = args;
          yield toToolCallDoneEvent(toolCall, args);
        }
      } else if (event.type === "response.completed") {
        if (completedResponse) throw malformedStreamError();
        assertAllToolCallsCompleted(toolCallOrder);
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

  const content: ContentPart[] = [];
  if (accumulatedText) content.push({ type: "text", text: accumulatedText });
  for (const pending of toolCallOrder) {
    const toolCall: ToolCall = {
      type: "tool_call",
      id: pending.id,
      ...(pending.itemId ? { itemId: pending.itemId } : {}),
      name: pending.name,
      args: pending.args!,
    };
    content.push(toolCall);
  }
  const stopReason = toolCallOrder.length > 0 ? ("tool_use" as const) : ("end_turn" as const);
  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: toolCallOrder.length > 0 ? content : accumulatedText,
    },
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
  const configurationError = () =>
    new ProviderError(
      "azure",
      "Azure OpenAI baseUrl must be a full HTTPS URL ending in /responses, without credentials or a fragment.",
    );

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/responses")
  ) {
    throw configurationError();
  }

  return url.toString();
}

function parseFunctionCallItem(
  item: Record<string, unknown>,
  requireArguments: boolean,
): AzureFunctionCallItem {
  if (
    !nonEmptyString(item.call_id) ||
    (item.id !== undefined && !nonEmptyString(item.id)) ||
    !nonEmptyString(item.name) ||
    (requireArguments && typeof item.arguments !== "string") ||
    (!requireArguments && item.arguments !== undefined && typeof item.arguments !== "string")
  ) {
    throw malformedToolCallStreamError();
  }
  return {
    id: item.call_id,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    name: item.name,
    ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {}),
  };
}

function parseOutputIndex(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw malformedToolCallStreamError();
  return value as number;
}

function findToolCall(
  outputIndex: unknown,
  itemId: unknown,
  toolCallsByOutputIndex: Map<number, PendingAzureToolCall>,
  toolCallsByItem: Map<string, PendingAzureToolCall>,
): PendingAzureToolCall {
  const toolCall = toolCallsByOutputIndex.get(parseOutputIndex(outputIndex));
  if (!toolCall) throw malformedToolCallStreamError();
  bindItemId(toolCall, itemId, toolCallsByItem);
  return toolCall;
}

function bindItemId(
  toolCall: PendingAzureToolCall,
  itemId: unknown,
  toolCallsByItem: Map<string, PendingAzureToolCall>,
): void {
  if (itemId === undefined) return;
  if (!nonEmptyString(itemId)) throw malformedToolCallStreamError();
  const boundToolCall = toolCallsByItem.get(itemId);
  if (
    (toolCall.itemId && toolCall.itemId !== itemId) ||
    (boundToolCall && boundToolCall !== toolCall)
  ) {
    throw malformedToolCallStreamError();
  }
  toolCall.itemId = itemId;
  toolCallsByItem.set(itemId, toolCall);
}

function parseCompleteToolArguments(argsJson: string): Record<string, unknown> {
  try {
    const args = JSON.parse(argsJson) as unknown;
    if (isJsonObject(args)) return args;
  } catch {
    // Fall through to the deterministic public protocol error.
  }
  throw malformedToolCallStreamError();
}

function assertAllToolCallsCompleted(toolCalls: PendingAzureToolCall[]): void {
  if (toolCalls.some((toolCall) => !toolCall.args)) {
    throw incompleteToolCallStreamError();
  }
}

function toToolCallDoneEvent(
  toolCall: PendingAzureToolCall,
  args: Record<string, unknown>,
): Extract<StreamEvent, { type: "toolcall_done" }> {
  return {
    type: "toolcall_done",
    id: toolCall.id,
    ...(toolCall.itemId ? { itemId: toolCall.itemId } : {}),
    name: toolCall.name,
    args,
  };
}

function malformedToolCallStreamError(): ProviderError {
  return new ProviderError("azure", "Azure OpenAI returned a malformed tool-call stream.");
}

function incompleteToolCallStreamError(): ProviderError {
  return new ProviderError(
    "azure",
    "Azure OpenAI tool-call stream ended before all calls completed.",
  );
}

function malformedStreamError(): ProviderError {
  return new ProviderError("azure", "Azure OpenAI returned a malformed response stream.");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asCompletedResponse(value: unknown): ResponsesCompletedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("azure", "Azure OpenAI returned a malformed response stream.");
  }
  return value as ResponsesCompletedPayload;
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

function toUsage(usage: ResponsesCompletedPayload["usage"]): Usage {
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
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
