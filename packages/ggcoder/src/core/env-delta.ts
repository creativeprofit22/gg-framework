import type { Message } from "@kenkaiiii/gg-ai";
import type { SystemPromptEnvironment } from "../system-prompt.js";

/**
 * Keep the model's picture of its environment true without breaking the cache.
 *
 * The Environment section (working directory, extra roots, network allowlist)
 * is rendered ONCE into the cached system prompt. Some of those facts can
 * still change mid-session: `/set networkAllow ...` rewrites the allowlist in
 * settings, and nothing re-renders the prompt. The model then keeps reading
 * the old list, so it cannot explain why a fetch is being blocked — it argues
 * with a host it believes is allowed, or avoids one that now is.
 *
 * Re-rendering the prompt to fix that is the expensive answer: the Environment
 * section is the LAST cached section, so rewriting it invalidates everything
 * after it too (measured at ~10k tokens on a small conversation, ~120k on a
 * large one, to correct ~40 tokens of text). Instead, append the difference as
 * one short hidden message: correct facts at append-only cost, with every
 * cached byte before it left untouched.
 */

/** A stable identity for the facts we render, so an unchanged env is free. */
export function fingerprintEnvironment(env: SystemPromptEnvironment): string {
  return JSON.stringify({
    roots: [...(env.additionalRoots ?? [])],
    allow: [...(env.networkAllow ?? [])],
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function describeList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.join(", ") : empty;
}

/**
 * The delta between what the prompt says and what is now true, or `null` when
 * they agree — the dedupe that keeps an unchanged environment at zero tokens.
 */
export function buildEnvDeltaMessage(
  rendered: SystemPromptEnvironment,
  current: SystemPromptEnvironment,
): Message | null {
  if (fingerprintEnvironment(rendered) === fingerprintEnvironment(current)) return null;

  const lines: string[] = [];
  const currentRoots = current.additionalRoots ?? [];
  if (!sameList(rendered.additionalRoots ?? [], currentRoots)) {
    lines.push(`- Additional roots are now: ${describeList(currentRoots, "(none)")}`);
  }

  const currentAllow = current.networkAllow ?? [];
  if (!sameList(rendered.networkAllow ?? [], currentAllow)) {
    lines.push(
      currentAllow.length > 0
        ? `- Network allowlist is now: ${describeList(currentAllow, "(none)")} (other hosts are blocked)`
        : "- The network allowlist no longer restricts hosts",
    );
  }

  if (lines.length === 0) return null;

  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content:
      "Environment update. The Environment section near the top of your instructions was " +
      "written when this session started and is now out of date:\n" +
      lines.join("\n") +
      "\nTrust these values over that section. Do not restate this note; just proceed.",
  };
}
