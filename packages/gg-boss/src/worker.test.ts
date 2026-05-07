import { describe, it, expect } from "vitest";
import { classifyWorkerError } from "./worker.js";

describe("classifyWorkerError — context overflow", () => {
  // Each provider phrases context-overflow differently. These canonical strings
  // come from real production errors documented across multiple agent codebases.
  const cases: Array<[string, string]> = [
    [
      "OpenAI Codex/Responses",
      '[openai] Codex error: {"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model"}}',
    ],
    [
      "OpenAI Chat Completions canonical",
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
    ],
    ["Anthropic token overflow", "API Error: prompt is too long: 213462 tokens > 200000 maximum"],
    [
      "Anthropic HTTP 413 byte overflow",
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    ],
    [
      "Google Gemini",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
    ],
    [
      "xAI / Grok",
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    ],
    [
      "Mistral",
      "Prompt contains 50000 tokens, too large for model with 32000 maximum context length",
    ],
    ["Amazon Bedrock", "ValidationException: input is too long for requested model"],
    [
      "OpenRouter",
      "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens.",
    ],
    [
      "Groq",
      "Please reduce the length of the messages or completion to fit within the model's context window.",
    ],
    [
      "DeepSeek (OpenAI-compatible)",
      'Error: {"error":{"code":"context_length_exceeded","message":"context length exceeded"}}',
    ],
    ["Generic 'token limit'", "Internal error: token limit reached for current request"],
  ];

  for (const [name, raw] of cases) {
    it(`tags [${name}] as [context_overflow]`, () => {
      const out = classifyWorkerError(raw);
      expect(out, `for ${name}`).toMatch(/^\[context_overflow\]/);
      expect(out, `for ${name}`).toContain("reset_worker");
      expect(out, `for ${name}`).toContain(raw);
    });
  }

  it("is case-insensitive", () => {
    expect(classifyWorkerError("CONTEXT_LENGTH_EXCEEDED at /v1/responses")).toMatch(
      /^\[context_overflow\]/,
    );
    expect(classifyWorkerError("PROMPT IS TOO LONG: 1000 > 100")).toMatch(/^\[context_overflow\]/);
  });
});

describe("classifyWorkerError — rate limited", () => {
  const cases = [
    "HTTP 429 Too Many Requests",
    "Rate limit exceeded for org-abc",
    "rate-limit hit: try again in 30s",
    "rate_limit_exceeded",
    "You exceeded 100 tokens per minute on this model",
    "60 requests per minute limit reached",
  ];
  for (const raw of cases) {
    it(`tags "${raw}" as [rate_limited]`, () => {
      expect(classifyWorkerError(raw)).toMatch(/^\[rate_limited\]/);
    });
  }
});

describe("classifyWorkerError — billing", () => {
  const cases = [
    "Insufficient balance on account",
    "Quota exceeded — please recharge",
    "quota_exceeded",
    "Your credit balance is too low",
    "402 Payment Required",
    "insufficient_quota: free tier exhausted",
  ];
  for (const raw of cases) {
    it(`tags "${raw}" as [billing]`, () => {
      expect(classifyWorkerError(raw)).toMatch(/^\[billing\]/);
    });
  }
});

describe("classifyWorkerError — auth", () => {
  const cases = [
    "invalid_api_key",
    "Invalid API key provided",
    "HTTP 401 Unauthorized",
    "authentication failed",
    "Please run /login to re-authenticate",
  ];
  for (const raw of cases) {
    it(`tags "${raw}" as [auth]`, () => {
      expect(classifyWorkerError(raw)).toMatch(/^\[auth\]/);
    });
  }
});

describe("classifyWorkerError — precedence + fall-through", () => {
  it("context_overflow wins over rate_limit envelope (some providers wrap overflow in 429)", () => {
    // A few providers return 429 even for context overflow; we want the
    // structural meaning (overflow → reset), not the transport (429 → retry).
    const raw = "HTTP 429: prompt is too long: 1000 > 500 maximum";
    expect(classifyWorkerError(raw)).toMatch(/^\[context_overflow\]/);
  });

  it("billing wins over auth when both substrings present", () => {
    // 402 Payment Required + 401-like phrasing; billing recovery (surface)
    // is correct here, not auth re-login.
    const raw = "402 Payment Required: insufficient balance, unauthorized to continue";
    expect(classifyWorkerError(raw)).toMatch(/^\[billing\]/);
  });

  it("passes through truly unknown errors verbatim", () => {
    const raw = "Some unexpected error nobody anticipated";
    expect(classifyWorkerError(raw)).toBe(raw);
  });

  it("preserves the original message after the tag for debugging", () => {
    const raw = "context_length_exceeded: input too big";
    const out = classifyWorkerError(raw);
    expect(out).toContain("Original: " + raw);
  });
});
