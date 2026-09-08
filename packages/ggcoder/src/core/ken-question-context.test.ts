import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { createAskUserBridge, type AskUserPrompt } from "./ask-user.js";
import { createAskUserTool } from "../tools/ask-user.js";
import {
  buildKenDigest,
  buildKenInteractiveSessionContext,
  buildKenAutopilotContext,
} from "./ken-context.js";

const questions = [
  {
    id: "history",
    kind: "choice" as const,
    question: "Should vendor history keep a fixed native limit?",
    detail: "Pagination alone cannot satisfy the fixture.",
    options: [
      {
        label: "Keep 1,000 vendor outcomes",
        value: "bounded",
        hint: "Preserve outcomes; refuse new jobs at the limit.",
        recommended: true,
      },
      {
        label: "Remove lifetime count limits",
        value: "unbounded",
        hint: "Requires a storage migration.",
      },
    ],
    allowOther: false,
  },
  { id: "confirm", kind: "confirm" as const, question: "Proceed with the selected approach?" },
];
const base = { question: "Explain the choices", cwd: "/project", gitBranch: null };
const call: Message = {
  role: "assistant",
  content: [{ type: "tool_call", id: "call-1", name: "ask_user", args: { questions } }],
};

function expectQuestions(digest: string) {
  expect(digest).toContain(JSON.stringify(questions));
}

describe("Ken question context", () => {
  it("preserves every question field in interactive and autopilot transcripts", () => {
    expectQuestions(buildKenDigest({ ...base, messages: [call] }));
    expectQuestions(buildKenAutopilotContext({ ...base, messages: [call] }));
  });

  it("pins live cards independently of transcript retention and clears settled cards", async () => {
    let prompt: AskUserPrompt | undefined;
    const bridge = createAskUserBridge({
      broadcast: (value) => {
        prompt = value;
      },
    });
    const pending = bridge.park({ questions });
    const messages: Message[] = [
      call,
      ...Array.from({ length: 25 }, (): Message => ({ role: "user", content: "Later activity" })),
    ];
    const session = {
      getMessages: () => messages,
      getContinuationReviewRecord: () => undefined,
      getConversationIdentity: () => ({ conversationId: "conversation" }),
      getState: () => ({ openAICodexContextProfile: "default" }),
    };
    const digest = () =>
      buildKenInteractiveSessionContext(session, {
        ...base,
        pendingQuestions: bridge.pendingRequests,
      });
    try {
      expectQuestions(digest());
      messages.splice(0, messages.length, {
        role: "user",
        content: "[Previous conversation summary] Compacted",
      });
      expectQuestions(digest());
      expect(digest()).toContain("not user answers or authorization");
      expect(prompt).toBeDefined();
      bridge.settle(prompt!.id, { action: "answer", answers: { history: "bounded" } });
      await pending;
      expect(digest()).not.toContain(questions[0].question);
    } finally {
      bridge.cancelAll();
    }
  });

  it("removes pending context on cancellation and timeout, with isolated snapshots", async () => {
    vi.useFakeTimers();
    const bridge = createAskUserBridge({ broadcast: () => {}, timeoutMs: 100 });
    try {
      const cancelled = bridge.park({ questions });
      const snapshot = bridge.pendingRequests;
      snapshot[0].questions[0].question = "Changed snapshot";
      expect(bridge.pendingRequests[0].questions[0].question).toBe(questions[0].question);
      bridge.cancelAll();
      await cancelled;
      expect(bridge.pendingRequests).toEqual([]);
      const timedOut = bridge.park({ questions });
      await vi.advanceTimersByTimeAsync(100);
      await timedOut;
      expect(bridge.pendingRequests).toEqual([]);
    } finally {
      bridge.cancelAll();
      vi.useRealTimers();
    }
  });

  it("keeps embedded fences inside quoted question data", () => {
    const embedded = [{ question: "Compare ```json and ```` examples" }];
    const digest = buildKenDigest({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "quoted", name: "ask_user", args: { questions: embedded } },
          ],
        },
      ],
    });
    expect(digest).toContain(`\n\`\`\`\`\`json\n${JSON.stringify(embedded)}\n\`\`\`\`\`\n`);
  });

  it("preserves valid oversized live cards and historical choices across Ken modes", async () => {
    const bridge = createAskUserBridge({ broadcast: () => {} });
    const tool = createAskUserTool(bridge.park);
    const parsed = tool.parameters.parse({
      questions: questions.map((q, index) => ({
        ...q,
        ...(index === 0 ? { detail: "Reference context. ".repeat(1000) } : {}),
      })),
    });
    const execution = tool.execute(parsed, {
      signal: new AbortController().signal,
      toolCallId: "large-valid",
      onUpdate: () => {},
    });
    try {
      expect(bridge.pendingRequests).toHaveLength(1);
      expect(bridge.pendingRequests[0].questions[0].options).toEqual(questions[0].options);
      const transcript: Message[] = [{
        role: "assistant",
        content: [{ type: "tool_call", id: "large-valid", name: "ask_user", args: parsed }],
      }];
      for (const build of [buildKenDigest, buildKenAutopilotContext]) {
        for (const input of [
          { messages: [], pendingQuestions: bridge.pendingRequests },
          { messages: transcript },
        ]) {
          const digest = build({ ...base, ...input });
          expect(digest).toContain(JSON.stringify(questions[0].options));
          expect(digest).toContain(questions[1].question);
          expect(digest).toContain('"kind":"choice"');
          expect(digest).toContain('"allowOther":false');
          expect(digest).toContain("more chars]");
          expect(digest).toContain("not user answers or authorization");
          expect(digest.length).toBeLessThan(20_000);
        }
      }
    } finally {
      bridge.cancelAll();
      await execution;
    }
    expect(bridge.pendingRequests).toEqual([]);
  });

  it("budgets escaped fields across a full valid batch without losing decision slots", async () => {
    const bridge = createAskUserBridge({ broadcast: () => {} });
    const tool = createAskUserTool(bridge.park);
    const long = '\u0000"\\\\````😀'.repeat(4000);
    const parsed = tool.parameters.parse({
      questions: Array.from({ length: 5 }, (_, q) => ({
        id: `question-${q}`,
        question: `Question ${q}: ${long}`,
        kind: "multi",
        detail: long,
        allowOther: false,
        options: Array.from({ length: 6 }, (_, o) => ({
          label: o === 5 ? "Keep the current behavior" : `Action ${o}: ${long}`,
          value: o === 5 ? "unchanged" : `value-${o}-${long}`,
          hint: long,
          recommended: o === 5,
        })),
      })),
    });
    const execution = tool.execute(parsed, {
      signal: new AbortController().signal,
      toolCallId: "full-valid",
      onUpdate: () => {},
    });
    try {
      expect(bridge.pendingRequests).toHaveLength(1);
      for (const build of [buildKenDigest, buildKenAutopilotContext]) {
        const digest = build({ ...base, messages: [], pendingQuestions: bridge.pendingRequests });
        const quoted = digest.match(/(`{3,})json\n([^\n]+)\n\1/);
        expect(quoted).not.toBeNull();
        expect(quoted![2].length).toBeLessThanOrEqual(16_000);
        const rendered = tool.parameters.parse({ questions: JSON.parse(quoted![2]) }).questions;
        expect(rendered).toHaveLength(5);
        for (const [index, q] of rendered.entries()) {
          expect(q.id).toBe(`question-${index}`);
          expect(q.kind).toBe("multi");
          expect(q.allowOther).toBe(false);
          expect(q.question).toContain("more chars]");
          expect(q.detail).toContain("more chars]");
          expect(q.options).toHaveLength(6);
          for (const [optionIndex, option] of q.options!.entries()) {
            expect(option.recommended).toBe(optionIndex === 5);
            expect(option.hint).toContain("more chars]");
            if (optionIndex === 5) {
              expect(option.label).toBe("Keep the current behavior");
              expect(option.value).toBe("unchanged");
            } else {
              expect(option.label).toContain(`Action ${optionIndex}:`);
              expect(option.label).toContain("more chars]");
              expect(option.value).toContain(`value-${optionIndex}-`);
              expect(option.value).toContain("more chars]");
            }
          }
        }
      }
      expect(bridge.pendingRequests[0].questions).toEqual(parsed.questions);
    } finally {
      bridge.cancelAll();
      await execution;
    }
  });

  it("bounds oversized question payloads explicitly without affecting ordinary tool summaries", () => {
    const digest = buildKenDigest({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "large",
              name: "ask_user",
              args: { questions: [{ question: "x".repeat(30_000) }] },
            },
            { type: "tool_call", id: "read", name: "read", args: { file_path: "README.md" } },
          ],
        },
      ],
    });
    expect(digest).toContain("more chars]");
    expect(digest.length).toBeLessThan(20_000);
    expect(digest).toContain("read(README.md)");
  });
});
