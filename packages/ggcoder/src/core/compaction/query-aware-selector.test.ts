import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { selectMessagesInBudget } from "./compactor.js";
import { estimateConversationTokens } from "./token-estimator.js";
import { findLatestHumanQuery, selectQueryAwareContext } from "./query-aware-selector.js";

function message(role: "user" | "assistant", content: string): Message {
  return { role, content };
}

describe("selectQueryAwareContext", () => {
  it("keeps older evidence relevant to the latest request ahead of unrelated recent context", () => {
    const messages = [
      message("user", "Build the account settings flow."),
      message(
        "assistant",
        "AuthService validates the OAuth callback verifier in src/auth/callback.ts.",
      ),
      message("assistant", "Adjusted unrelated dashboard colors and spacing."),
      message("user", "Fix the OAuth callback verifier mismatch in AuthService."),
    ];
    const budget = estimateConversationTokens([messages[0], messages[1], messages[3]]);

    const result = selectQueryAwareContext(
      messages,
      "Fix the OAuth callback verifier mismatch in AuthService.",
      budget,
      { fallback: selectMessagesInBudget },
    );

    expect(result.strategy).toBe("query_aware");
    expect(result.messages).toEqual([messages[0], messages[1], messages[3]]);
    expect(result.messages).not.toContain(messages[2]);
  });

  it("never exceeds the hard token budget", () => {
    const messages = [
      message("user", `Original request ${"a".repeat(1_000)}`),
      message("assistant", `OAuth callback evidence ${"b".repeat(1_000)}`),
      message("assistant", `OAuth verifier definition ${"c".repeat(1_000)}`),
      message("user", "Investigate the OAuth verifier."),
    ];
    const budget = 320;

    const result = selectQueryAwareContext(messages, "Investigate the OAuth verifier.", budget, {
      fallback: selectMessagesInBudget,
    });

    expect(result.selectedTokens).toBeLessThanOrEqual(budget);
    expect(estimateConversationTokens(result.messages)).toBeLessThanOrEqual(budget);
  });

  it("uses the existing selector deterministically when the query has no signal", () => {
    const messages = [
      message("user", "first"),
      message("assistant", "middle"),
      message("user", "latest"),
    ];
    const fallback = vi.fn(selectMessagesInBudget);

    const first = selectQueryAwareContext(messages, "please continue", 100, { fallback });
    const second = selectQueryAwareContext(messages, "please continue", 100, { fallback });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ strategy: "fallback", fallbackReason: "empty_query" });
    expect(first.messages).toEqual(selectMessagesInBudget(messages, 100));
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("falls back without throwing when retrieval fails or returns invalid rankings", () => {
    const messages = [
      message("user", "Original OAuth request"),
      message("assistant", "OAuth implementation evidence"),
      message("user", "Fix OAuth verifier"),
    ];
    const expected = selectMessagesInBudget(messages, 100);

    const failed = selectQueryAwareContext(messages, "Fix OAuth verifier", 100, {
      fallback: selectMessagesInBudget,
      retrieve: () => {
        throw new Error("retriever unavailable");
      },
    });
    const invalid = selectQueryAwareContext(messages, "Fix OAuth verifier", 100, {
      fallback: selectMessagesInBudget,
      retrieve: () => [{ index: 99, score: 1 }],
    });

    expect(failed).toMatchObject({
      strategy: "fallback",
      fallbackReason: "retrieval_failed",
      messages: expected,
    });
    expect(invalid).toMatchObject({
      strategy: "fallback",
      fallbackReason: "invalid_ranking",
      messages: expected,
    });
  });
});

describe("findLatestHumanQuery", () => {
  it("ignores runtime continuation messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Fix the OAuth verifier",
        provenance: { source: "human", kind: "prompt", visibility: "transcript" },
      },
      {
        role: "user",
        content: "Continue after compaction",
        provenance: { source: "runtime", kind: "continuation", visibility: "hidden" },
      },
    ];

    expect(findLatestHumanQuery(messages)).toBe("Fix the OAuth verifier");
  });
});
