import OpenAI from "openai";
import type { ContentPart, StreamEvent, StreamOptions, StreamResponse } from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { parseToolArguments } from "../utils/json.js";
import { getEnvironment } from "../utils/env.js";
import {
  getQwenCloudCapability,
  normalizeQwenCloudThinking,
  QWEN_CLOUD_TOKEN_PLAN_ENDPOINT,
} from "../qwen-cloud-policy.js";
import {
  downgradeUnsupportedImages,
  downgradeUnsupportedVideos,
  normalizeOpenAIStopReason,
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIToolChoice,
} from "./transform.js";
import {
  completionToResponse,
  extractOpenAIUsage,
  synthesizeEventsFromCompletion,
} from "./openai.js";

const TIMEOUT_MS = 120_000;
class SafeQwenError extends ProviderError {}
const safeError = (message: string) => new SafeQwenError("qwen-cloud", message);

/** No ambient credentials, caller transport hooks, or endpoint aliases are accepted.
 * OS trust roots and the host's networking implementation remain trusted. */
export function streamQwenCloud(options: StreamOptions): StreamResult {
  return new StreamResult(run(options), options.signal);
}

async function* run(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    const model = getQwenCloudCapability(options.model);
    if (
      !model ||
      options.provider !== "qwen-cloud" ||
      options.baseUrl !== undefined ||
      options.defaultHeaders !== undefined ||
      options.fetch !== undefined ||
      options.accountId !== undefined ||
      getEnvironment()?.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ) {
      throw safeError("Qwen Cloud Token Plan configuration is not allowed.");
    }
    const key = options.apiKey;
    if (typeof key !== "string" || !/^sk-sp-[A-Za-z0-9_-]{1,250}$/.test(key)) {
      throw safeError("Qwen Cloud requires a valid Token Plan key.");
    }
    const maxTokens = options.maxTokens ?? model.maxOutputTokens;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxOutputTokens) {
      throw safeError("Qwen Cloud output limit is not allowed.");
    }
    const thinking = normalizeQwenCloudThinking(model.id, options.thinking);
    const { temperature, topP, stop } = options;
    // Chat schema: temperature [0, 2), top_p (0, 1]; set only one.
    // https://docs.qwencloud.com/api-reference/chat/openai-chat.md
    // Token Plan documents a 0.6 floor for qwen3.8-max thinking mode.
    // Reject rather than silently accept a value the service would clamp.
    // https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/opencode
    const minTemperature = model.apiModelId === "qwen3.8-max" && thinking ? 0.6 : 0;
    if (
      (temperature != null &&
        (!Number.isFinite(temperature) || temperature < minTemperature || temperature >= 2)) ||
      (topP != null && (!Number.isFinite(topP) || topP <= 0 || topP > 1)) ||
      (temperature != null && topP != null) ||
      (stop != null &&
        (!Array.isArray(stop) || Array.from(stop).some((value) => typeof value !== "string")))
    ) {
      throw safeError("Qwen Cloud sampling or stop configuration is not allowed.");
    }
    const messages = toOpenAIMessages(
      downgradeUnsupportedVideos(downgradeUnsupportedImages(options.messages, false), false),
      {
        provider: "qwen-cloud",
        thinking: !!thinking,
        supportsImages: false,
        reasoningField: "reasoning_content",
      },
    );
    // Leave preserve_thinking / clear_thinking absent: vendor defaults differ,
    // notably GLM 5.3 clears history while GLM 5.2 preserves it. Still roundtrip
    // the original reasoning_content separately, never as visible text.
    const params = {
      model: model.apiModelId,
      messages,
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { top_p: topP } : {}),
      ...(stop != null ? { stop } : {}),
      stream: options.streaming !== false,
      ...(options.streaming !== false ? { stream_options: { include_usage: true } } : {}),
      // Qwen's legacy max_tokens excludes reasoning. Use the combined cap
      // where documented; GLM documents a combined max_tokens cap without budget.
      ...(model.apiModelId.startsWith("glm-")
        ? { max_tokens: maxTokens }
        : { max_completion_tokens: maxTokens }),
      ...(model.apiModelId === "glm-5.3" ? {} : { enable_thinking: !!thinking }),
      ...(thinking && model.thinking.kind === "effort" ? { reasoning_effort: thinking } : {}),
      ...(options.tools?.length
        ? {
            tools: toOpenAITools(options.tools, { strict: false }),
            ...(options.toolChoice ? { tool_choice: toOpenAIToolChoice(options.toolChoice) } : {}),
          }
        : {}),
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(abort, TIMEOUT_MS);
    const client = new OpenAI({
      apiKey: key,
      baseURL: QWEN_CLOUD_TOKEN_PLAN_ENDPOINT.slice(0, -"/chat/completions".length),
      organization: null,
      project: null,
      webhookSecret: null,
      maxRetries: 0,
      timeout: TIMEOUT_MS,
      logLevel: "off",
      fetch: async (input, init) => {
        // Last boundary before a credential-bearing request. Rebuild init rather
        // than forwarding SDK/caller proxy, dispatcher, header or redirect options.
        if (
          String(input) !== QWEN_CLOUD_TOKEN_PLAN_ENDPOINT ||
          init?.method !== "POST" ||
          getEnvironment()?.NODE_TLS_REJECT_UNAUTHORIZED === "0"
        ) {
          throw safeError("Qwen Cloud Token Plan configuration is not allowed.");
        }
        const response = await globalThis.fetch(QWEN_CLOUD_TOKEN_PLAN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: init.body,
          signal: init.signal,
          redirect: "error",
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw safeError("Qwen Cloud redirect refused.");
        }
        return response;
      },
    });
    if (options.streaming === false) {
      const completion = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) throw safeError("Qwen Cloud request cancelled or timed out.");
      const choice = completion.choices?.[0];
      if (!choice?.message || typeof choice.finish_reason !== "string" || !choice.finish_reason) {
        throw safeError("Qwen Cloud returned an invalid response.");
      }
      const response = completionToResponse(completion, QWEN_CLOUD_TOKEN_PLAN_ENDPOINT);
      // Match Qwen's streaming path: preserve and emit returned reasoning even
      // for always-on models when the caller did not explicitly request thinking.
      yield* synthesizeEventsFromCompletion(completion, true, QWEN_CLOUD_TOKEN_PLAN_ENDPOINT);
      return {
        ...response,
        message: { ...response.message, content: response.message.content || [] },
        usage: { cacheRead: 0, cacheWrite: 0, ...response.usage },
      };
    }
    const chunks = await client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: controller.signal },
    );
    let text = "",
      reasoning = "",
      finish: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    const tools = new Map<number, { id: string; name: string; argsJson: string }>();
    for await (const chunk of chunks) {
      if (controller.signal.aborted) throw safeError("Qwen Cloud request cancelled or timed out.");
      if (chunk.usage) usage = extractOpenAIUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (!Array.isArray(chunk.choices))
          throw safeError("Qwen Cloud returned an invalid response.");
        continue;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      const r = (delta as unknown as { reasoning_content?: string }).reasoning_content;
      if (r) {
        reasoning += r;
        yield { type: "thinking_delta", text: r };
      }
      if (delta.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const accum = tools.get(tc.index) ?? { id: "", name: "", argsJson: "" };
        tools.set(tc.index, accum);
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name = tc.function.name;
        if (tc.function?.arguments) {
          accum.argsJson += tc.function.arguments;
          yield {
            type: "toolcall_delta",
            id: accum.id,
            name: accum.name,
            argsJson: tc.function.arguments,
          };
        }
      }
    }
    if (controller.signal.aborted) throw safeError("Qwen Cloud request cancelled or timed out.");
    if (!finish) throw safeError("Qwen Cloud response ended before completion.");
    const content: ContentPart[] = [];
    if (reasoning) content.push({ type: "thinking", text: reasoning });
    if (text) content.push({ type: "text", text });
    for (const tool of tools.values()) {
      const args = parseToolArguments(tool.argsJson);
      content.push({ type: "tool_call", id: tool.id, name: tool.name, args });
      yield { type: "toolcall_done", id: tool.id, name: tool.name, args };
    }
    const stopReason = normalizeOpenAIStopReason(finish);
    yield { type: "done", stopReason };
    return { message: { role: "assistant", content }, stopReason, usage };
  } catch (error) {
    // Never retain a raw SDK error/cause, response body, header or request ID.
    if (error instanceof SafeQwenError) throw error;
    if (controller.signal.aborted) throw safeError("Qwen Cloud request cancelled or timed out.");
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    if (status === 401 || status === 403)
      throw safeError("Qwen Cloud Token Plan authentication failed.");
    if (status === 402 || status === 429)
      throw safeError("Qwen Cloud Token Plan usage limit reached.");
    // Only an explicit structured code on a bad-request response establishes
    // overflow. Never infer it from echoed message text or an HTTP status alone.
    if (
      error instanceof OpenAI.APIError &&
      status === 400 &&
      error.code === "context_length_exceeded"
    ) {
      throw safeError("Qwen Cloud Token Plan prompt is too long.");
    }
    throw safeError("Qwen Cloud Token Plan request failed.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
