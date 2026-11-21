import type { Message } from "@kenkaiiii/gg-ai";
import type { AskUserPrompt } from "./core/ask-user.js";
import { parseKenAskAnswer, type KenAskAnswer } from "./core/ken-ask-answer.js";
import { lastAssistantText } from "./app-sidecar/ken-context.js";

export interface KenAskDeps<P extends string = string> {
  enabled: () => boolean;
  setReviewing: (reviewing: boolean) => void;
  ensureKen: () => Promise<{ prompt(text: string): Promise<unknown>; getMessages(): Message[] }>;
  buildDigest: (prompt: AskUserPrompt) => Promise<string>;
  /** Takes (and clears) a model switch that landed while Ken was busy. */
  takePendingModel: () => { provider: P; model: string } | null;
  syncModel: (provider: P, model: string) => Promise<void>;
}

/** Ken answers question cards one at a time: parallel ask_user calls and
 * Autopilot reviews share the one kenAuto session, which takes a single prompt
 * at a time. Reviews await `idle()` before prompting. */
export function createKenAskQueue<P extends string>(deps: KenAskDeps<P>) {
  let chain: Promise<unknown> = Promise.resolve();

  async function answerOne(
    prompt: AskUserPrompt,
    isPending: () => boolean,
  ): Promise<KenAskAnswer | null> {
    if (!deps.enabled() || !isPending()) return null;
    deps.setReviewing(true);
    try {
      const ken = await deps.ensureKen();
      await ken.prompt(await deps.buildDigest(prompt));
      return parseKenAskAnswer(lastAssistantText(ken.getMessages()), prompt.questions);
    } finally {
      deps.setReviewing(false);
      const pending = deps.takePendingModel();
      if (pending) await deps.syncModel(pending.provider, pending.model);
    }
  }

  return {
    /** Null when the card was no longer pending (or autopilot went off) by Ken's turn. */
    answer(prompt: AskUserPrompt, isPending: () => boolean): Promise<KenAskAnswer | null> {
      const run = chain.then(() => answerOne(prompt, isPending));
      chain = run.catch(() => {});
      return run;
    },
    idle(): Promise<unknown> {
      return chain;
    },
  };
}
