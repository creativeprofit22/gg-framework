import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import { estimateMessageTokens } from "./token-estimator.js";

export interface RankedContextMessage {
  index: number;
  score: number;
}

export type ContextRetriever = (
  messages: readonly Message[],
  query: string,
) => readonly RankedContextMessage[];

export interface QueryAwareSelectionResult {
  messages: Message[];
  strategy: "query_aware" | "fallback";
  selectedTokens: number;
  droppedMessages: number;
  queryTerms: number;
  fallbackReason?: "empty_query" | "retrieval_failed" | "invalid_ranking" | "no_relevant_messages";
}

export interface QueryAwareSelectionOptions {
  retrieve?: ContextRetriever;
  fallback: (messages: Message[], tokenBudget: number) => Message[];
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "but",
  "can",
  "continue",
  "could",
  "does",
  "for",
  "from",
  "have",
  "implement",
  "into",
  "item",
  "just",
  "next",
  "please",
  "should",
  "that",
  "the",
  "then",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const chunks: string[] = [];
  for (const part of message.content as (ContentPart | ToolResult)[]) {
    if (part.type === "tool_call") {
      chunks.push(part.name, JSON.stringify(part.args));
    } else if (part.type === "tool_result") {
      if (typeof part.content === "string") chunks.push(part.content);
      else
        chunks.push(
          ...part.content.filter((block) => block.type === "text").map((block) => block.text),
        );
    } else if ("text" in part && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

export function tokenizeRetrievalText(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_./:@-]{2,}/gu) ?? [];
  return matches
    .map((token) => token.replace(/^[./:@-]+|[.,:;!?]+$/g, ""))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/** Latest genuine human request; runtime continuation/control messages never become the query. */
export function findLatestHumanQuery(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (message.provenance && message.provenance.source !== "human") continue;
    const text = messageText(message).trim();
    if (text && !text.startsWith("[Runtime fact:")) return text;
  }
  return "";
}

/**
 * Deterministic lexical retriever. Rare identifiers, file paths and exact terms
 * naturally receive more weight through inverse document frequency.
 */
export const rankMessagesByQuery: ContextRetriever = (messages, query) => {
  const queryTerms = [...new Set(tokenizeRetrievalText(query))];
  if (queryTerms.length === 0) return [];

  const documentTerms = messages.map(
    (message) => new Set(tokenizeRetrievalText(messageText(message))),
  );
  const documentFrequency = new Map<string, number>();
  for (const terms of documentTerms) {
    for (const term of queryTerms) {
      if (terms.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const baseScores = messages.map((message, index) => {
    let score = 0;
    for (const term of queryTerms) {
      if (!documentTerms[index].has(term)) continue;
      const frequency = documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log((messages.length + 1) / (frequency + 1)) + 1;
      const entityBoost = /[./_:@-]/.test(term) || term.length >= 8 ? 2 : 1;
      score += inverseFrequency * entityBoost;
    }
    if (score > 0 && message.role === "user") score += 0.5;
    return score;
  });

  // Carry a smaller score to neighboring turns so selected evidence keeps the
  // question/answer or tool-result dependency that gives it meaning.
  const scores = [...baseScores];
  for (let index = 0; index < baseScores.length; index++) {
    if (baseScores[index] <= 0) continue;
    if (index > 0) scores[index - 1] = Math.max(scores[index - 1], baseScores[index] * 0.25);
    if (index + 1 < scores.length) {
      scores[index + 1] = Math.max(scores[index + 1], baseScores[index] * 0.25);
    }
  }

  return scores
    .map((score, index) => ({ index, score }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index);
};

function fallbackResult(
  messages: Message[],
  tokenBudget: number,
  fallback: QueryAwareSelectionOptions["fallback"],
  fallbackReason: QueryAwareSelectionResult["fallbackReason"],
  queryTerms: number,
): QueryAwareSelectionResult {
  const selected = fallback(messages, tokenBudget);
  return {
    messages: selected,
    strategy: "fallback",
    selectedTokens: selected.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    droppedMessages: messages.length - selected.length,
    queryTerms,
    fallbackReason,
  };
}

/**
 * Select query-relevant context under a hard token budget. Retrieval is
 * replaceable; invalid output or exceptions deterministically use the existing
 * recency selector instead of breaking compaction.
 */
export function selectQueryAwareContext(
  messages: Message[],
  query: string,
  tokenBudget: number,
  options: QueryAwareSelectionOptions,
): QueryAwareSelectionResult {
  const normalizedBudget = Math.max(0, Math.floor(tokenBudget));
  const queryTerms = new Set(tokenizeRetrievalText(query)).size;
  if (queryTerms === 0) {
    return fallbackResult(messages, normalizedBudget, options.fallback, "empty_query", queryTerms);
  }

  let ranking: readonly RankedContextMessage[];
  try {
    ranking = (options.retrieve ?? rankMessagesByQuery)(messages, query);
  } catch {
    return fallbackResult(
      messages,
      normalizedBudget,
      options.fallback,
      "retrieval_failed",
      queryTerms,
    );
  }

  const seen = new Set<number>();
  for (const { index, score } of ranking) {
    const invalid =
      !Number.isInteger(index) ||
      index < 0 ||
      index >= messages.length ||
      !Number.isFinite(score) ||
      score <= 0 ||
      seen.has(index);
    if (invalid) {
      return fallbackResult(
        messages,
        normalizedBudget,
        options.fallback,
        "invalid_ranking",
        queryTerms,
      );
    }
    seen.add(index);
  }
  if (ranking.length === 0) {
    return fallbackResult(
      messages,
      normalizedBudget,
      options.fallback,
      "no_relevant_messages",
      queryTerms,
    );
  }

  const selected = new Set<number>();
  let selectedTokens = 0;
  const trySelect = (index: number): void => {
    if (selected.has(index)) return;
    const tokens = estimateMessageTokens(messages[index]);
    if (selectedTokens + tokens > normalizedBudget) return;
    selected.add(index);
    selectedTokens += tokens;
  };

  // Preserve the original goal when it fits, matching the existing selector's
  // pinning behavior before relevance gets the remaining budget.
  const earliestUser = messages.findIndex((message) => message.role === "user");
  if (earliestUser >= 0) trySelect(earliestUser);
  for (const candidate of ranking) trySelect(candidate.index);
  // Spend unused budget on recent context, preserving deterministic behavior
  // when relevance alone does not fill the window.
  for (let index = messages.length - 1; index >= 0; index--) trySelect(index);

  return {
    messages: messages.filter((_message, index) => selected.has(index)),
    strategy: "query_aware",
    selectedTokens,
    droppedMessages: messages.length - selected.size,
    queryTerms,
  };
}
