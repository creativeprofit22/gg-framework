import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AskUserPrompt } from "./core/ask-user.js";
import { createKenAskQueue } from "./app-sidecar-ken-ask.js";

const prompt: AskUserPrompt = {
  id: "ask-1",
  questions: [{ id: "go", question: "Add the test?", kind: "confirm" }],
};

// A Ken session that replies from a script, one reply per prompt.
function harness(replies: string[]) {
  const ken = {
    messages: [] as Message[],
    prompts: [] as string[],
    concurrent: 0,
    maxConcurrent: 0,
    async prompt(text: string) {
      this.prompts.push(text);
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.messages.push({ role: "assistant", content: replies.shift() ?? "" });
      this.concurrent -= 1;
    },
    getMessages() {
      return this.messages;
    },
  };
  const state = {
    reviewing: false,
    reviewingSeen: [] as boolean[],
    pendingModel: null as { provider: string; model: string } | null,
    ensureKen: async () => {
      state.reviewingSeen.push(state.reviewing);
      return ken;
    },
  };
  const syncModel = vi.fn(async () => {});
  const queue = createKenAskQueue({
    enabled: () => true,
    setReviewing: (r) => {
      state.reviewing = r;
    },
    ensureKen: () => state.ensureKen(),
    buildDigest: async (p) => `## Question for you\n${p.questions[0]!.question}`,
    takePendingModel: () => {
      const pending = state.pendingModel;
      state.pendingModel = null;
      return pending;
    },
    syncModel,
  });
  return { state, ken, queue, syncModel };
}

describe("Ken answering question cards", () => {
  it("prompts Ken with the question and parses his answer", async () => {
    const { state, ken, queue } = harness(['ANSWER\n{"go":"yes"}']);
    expect(await queue.answer(prompt, () => true)).toEqual({
      kind: "answer",
      answers: { go: "yes" },
    });
    expect(ken.prompts[0]).toContain("## Question for you");
    expect(state.reviewingSeen).toEqual([true]);
    expect(state.reviewing).toBe(false);
  });

  it("answers one card at a time and a review waits for an answer in flight", async () => {
    const { ken, queue } = harness(['ANSWER {"go":"yes"}', "HUMAN\nDestructive."]);
    const order: string[] = [];
    const a = queue.answer(prompt, () => true).then((r) => (order.push("a"), r));
    const b = queue
      .answer({ ...prompt, id: "ask-2" }, () => true)
      .then((r) => (order.push("b"), r));
    await queue.idle();
    order.push("review");
    expect(ken.maxConcurrent).toBe(1);
    expect(await a).toMatchObject({ kind: "answer" });
    expect(await b).toEqual({ kind: "human", reason: "Destructive." });
    expect(order).toEqual(["a", "b", "review"]);
  });

  it("skips a card that is no longer pending and applies a model switch afterwards", async () => {
    const { state, ken, queue, syncModel } = harness(['ANSWER {"go":"no"}']);
    expect(await queue.answer(prompt, () => false)).toBeNull();
    expect(ken.prompts).toHaveLength(0);

    state.ensureKen = async () => {
      state.pendingModel = { provider: "anthropic", model: "m" };
      return ken;
    };
    await queue.answer(prompt, () => true);
    expect(syncModel).toHaveBeenCalledWith("anthropic", "m");
  });
});
