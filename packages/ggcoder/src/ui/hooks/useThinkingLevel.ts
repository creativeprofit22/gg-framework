import { useEffect, useState } from "react";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { clampThinkingLevel, resolveInitialThinkingLevel } from "../../core/thinking-level.js";

/** Keep runtime, status badges and remount snapshots on the same legal level. */
export function useThinkingLevel(provider: Provider, model: string, initial: ThinkingLevel | undefined) {
  const [savedLevel, setThinkingLevel] = useState(() =>
    resolveInitialThinkingLevel(provider, model, !!initial, initial),
  );
  // Normalize during render as well as persisting the adjustment: effects and
  // children must never observe an off state for an always-on model.
  const thinkingLevel = clampThinkingLevel(provider, model, savedLevel);
  useEffect(() => {
    if (savedLevel !== thinkingLevel) setThinkingLevel(thinkingLevel);
  }, [savedLevel, thinkingLevel]);
  return [thinkingLevel, setThinkingLevel] as const;
}
