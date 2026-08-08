export interface ChatResearchCommandMetadata {
  name: "research";
  aliases: readonly string[];
  description: string;
  usage: "/research [optional focus]";
  source: "built-in";
}

/** App-sidecar-owned metadata; this command is deliberately absent from the coding registry. */
export const CHAT_RESEARCH_COMMAND: ChatResearchCommandMetadata = Object.freeze({
  name: "research",
  aliases: Object.freeze([]),
  description: "Research this conversation and draft net-new Roadmap phases",
  usage: "/research [optional focus]",
  source: "built-in",
});

export interface ParsedChatResearchCommand {
  focus: string | null;
  displayText: string;
}

/** Collapse formatting-only whitespace without changing the user's words or punctuation. */
export function normalizeChatResearchFocus(focus: string): string | null {
  const normalized = focus.trim().replace(/\s+/gu, " ");
  return normalized || null;
}

/**
 * Recognize only the exact, case-sensitive `/research` command token.
 * Leading/trailing whitespace is input formatting; aliases and token prefixes are rejected.
 */
export function parseChatResearchCommand(input: string): ParsedChatResearchCommand | null {
  const trimmed = input.trim();
  if (trimmed === "/research") {
    return { focus: null, displayText: "/research" };
  }
  if (!trimmed.startsWith("/research") || !/^\s$/u.test(trimmed.charAt("/research".length))) {
    return null;
  }

  const focus = normalizeChatResearchFocus(trimmed.slice("/research".length));
  return {
    focus,
    displayText: focus ? `/research ${focus}` : "/research",
  };
}

/** Build the hidden instruction used to continue the same chat after switching to Research. */
export function buildChatResearchContinuationPrompt(focus?: string | null): string {
  const normalizedFocus = normalizeChatResearchFocus(focus ?? "");
  const focusInstruction = normalizedFocus
    ? `Prioritize this user-supplied focus while retaining relevant context from the full conversation:\n<research_focus>${normalizedFocus}</research_focus>`
    : "No narrower focus was supplied; infer the research scope from the full preceding conversation.";

  return `Continue this same chat as Research. Consume the entire preceding Brainstorm conversation as the authoritative context; do not ask the user to repeat or summarize it.

${focusInstruction}

Turn the explored ideas into an evidence-led proposal for the existing structured Project Notes Roadmap:
1. Identify the concrete candidate work, assumptions, tradeoffs, and unresolved questions in the conversation.
2. Gather and verify current authoritative evidence before proposing work. Prefer primary sources and open the exact source pages you rely on. Preserve canonical URLs for relevant proposed phases.
3. Ask one focused clarification instead of drafting only when a genuinely material product decision is missing. Otherwise make explicit, reasonable assumptions and proceed.
4. After research is complete, call \`roadmap_inspect\` immediately before preparing the draft. Compare against every current phase and remove work already covered. If nothing net-new remains, explain that it is already covered, do not call \`roadmap_phase_draft\`, and stop.
5. For only the net-new work, call \`roadmap_phase_draft\` with flat peer phases, concrete done-when criteria, and canonical references attached to the relevant proposed phases. Do not create nested phases or implementation slices.
6. After submitting the draft, stop pending explicit user approval. Do not approve it, mutate Project Notes directly, start a phase, implement anything, or open a coding session.

The only successful endpoint is either a researched draft awaiting explicit approval, a concise already-covered result, or one material clarification question.`;
}
