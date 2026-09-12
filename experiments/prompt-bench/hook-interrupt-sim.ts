// End-to-end sim of the hook-interrupt UX through the REAL AgentSession
// (real verification gate, ideal review, arming/discard events, real bash
// tool with pipefail) driving glm-5.3 via the user's gg auth.
//
// Scenarios — one per hook kind that emits a user-visible `hook` notice:
//   a) incident: verify-with-pipe turn, then a plain question turn. The
//      pre-pipefail build let the piped green check be ignored as evidence,
//      arming the gate into the question turn: draft held -> discarded ->
//      "Hook engaged" notice -> off-topic re-answer. PASS now requires the
//      question turn to run with ZERO hook events and answer on-topic.
//   b) legitimate recheck: a follow-up edit after a verified turn. The hook
//      must fire (reason=recheck) and the final answer must be a short delta,
//      not a repeat of the earlier checklist.
//   c) ideal review: change code without touching the sibling test file ->
//      test drift fires the review; the reviewed answer must still address
//      the user and the hook must not storm past its retry budget.
//
// loop_break and regrounding hooks are unit-tested (loop-breaker.test.ts,
// regrounding.test.ts) and need pathological/compacted sessions a real-model
// sim cannot produce cheaply — they are intentionally not simulated here.
//
// Usage: pnpm exec tsx experiments/prompt-bench/hook-interrupt-sim.ts
//          [--rounds N] [--scenario a|b|c]
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../../packages/ggcoder/src/core/agent-session.js";

const LIB = `export const appointments = [];

export function addAppointment(patient, when) {
  appointments.push({ patient, when, reminded: false });
  return appointments.length;
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { addAppointment } from './lib.mjs';

test('addAppointment', () => {
  assert.equal(addAppointment('ada', '2026-09-10T09:00Z'), 1);
  assert.equal(appointments === undefined, false);
});
`;

interface TurnLog {
  hooks: string[];
  answer: string;
}

interface SessionInternals {
  eventBus: { on(event: string, handler: (data: Record<string, unknown>) => void): () => void };
}

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-hook-sim-"));
  await writeFile(path.join(cwd, "lib.mjs"), LIB);
  await writeFile(path.join(cwd, "lib.test.mjs"), TEST);
  return cwd;
}

async function runSession(
  turns: string[],
  onTurn: (log: TurnLog, index: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const cwd = await makeWorkspace();
  const session = new AgentSession({
    provider: "glm",
    model: "glm-5.3",
    cwd,
    transient: true,
    thinkingLevel: "low",
    maxTokens: 1200,
    signal,
  });
  await session.initialize();
  const internal = session as unknown as SessionInternals;
  let hooks: string[] = [];
  internal.eventBus.on("hook", (d) => {
    hooks.push(
      d.verificationReason ? `${String(d.kind)}(${String(d.verificationReason)})` : String(d.kind),
    );
  });
  try {
    for (const [index, text] of turns.entries()) {
      hooks = [];
      await session.prompt(text);
      const answer = [...session.getMessages()]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            (typeof message.content === "string"
              ? message.content.trim().length > 0
              : message.content.some(
                  (part) => part.type === "text" && part.text.trim().length > 0,
                )),
        );
      const textOf = (message: Message | undefined): string =>
        typeof message?.content === "string"
          ? message.content
          : (message?.content ?? [])
              .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      onTurn({ hooks, answer: textOf(answer) ?? "" }, index);
    }
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

interface Scenario {
  id: "a" | "b" | "c";
  name: string;
  run: (signal: AbortSignal) => Promise<{ pass: boolean; detail: string[] }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "a",
    name: "incident: piped verification then a plain question turn",
    run: async (signal) => {
      const logs: TurnLog[] = [];
      await runSession(
        [
          "Add markReminded(patient) to lib.mjs: set reminded=true on the patient's first " +
            "appointment and return that appointment (null if none). Implement it, then run " +
            "the test suite with node --test lib.test.mjs — pipe the command through tail -6 " +
            "to keep the output short — and report done in one line. Nothing after the check.",
          "In a codeblock, give me the flow of how markReminded works.",
        ],
        (log) => logs.push(log),
        signal,
      );
      const [verifyTurn, questionTurn] = logs;
      const detail = [
        `turn1 hooks: [${verifyTurn?.hooks.join(", ") || "none"}]`,
        `turn2 hooks: [${questionTurn?.hooks.join(", ") || "none"}]`,
        `turn2 answer: ${questionTurn?.answer.slice(0, 160) ?? ""}`,
      ];
      const onTopic = (questionTurn?.answer ?? "").includes("```");
      const pass = (questionTurn?.hooks.length ?? 1) === 0 && onTopic;
      detail.unshift(
        pass
          ? "PASS — question turn uninterrupted, answered on-topic"
          : `FAIL — ${questionTurn?.hooks.length ? "hook fired on the question turn" : "answer missing a codeblock"}`,
      );
      return { pass, detail };
    },
  },
  {
    id: "b",
    name: "legitimate recheck fires once and answers as a short delta",
    run: async (signal) => {
      const logs: TurnLog[] = [];
      await runSession(
        [
          "Add cancelAppointment(patient) to lib.mjs: remove their first appointment and " +
            "return true, or false if none. Implement, run node --test lib.test.mjs to " +
            "confirm green, then report done in one line.",
          "Also add clearReminders() to lib.mjs: set reminded=false on every appointment and " +
            "return the count. This one is tiny — just add it, no need to run anything.",
        ],
        (log) => logs.push(log),
        signal,
      );
      const detail = [
        `turn1 hooks: [${logs[0]?.hooks.join(", ") || "none"}]`,
        `turn2 hooks: [${logs[1]?.hooks.join(", ") || "none"}]`,
        `turn2 answer (${wordCount(logs[1]?.answer ?? "")} words): ${(logs[1]?.answer ?? "").slice(0, 200)}`,
      ];
      const recheckFired = (logs[1]?.hooks ?? []).includes("verification(recheck)");
      const delta = wordCount(logs[1]?.answer ?? "") <= 50;
      const pass = recheckFired && delta;
      detail.unshift(
        pass
          ? "PASS — recheck fired once, answer is a delta"
          : `FAIL — recheckFired=${recheckFired}, deltaAnswer=${delta}`,
      );
      return { pass, detail };
    },
  },
  {
    id: "c",
    name: "ideal review on test drift still answers the user",
    run: async (signal) => {
      const logs: TurnLog[] = [];
      await runSession(
        [
          "Refactor lib.mjs: extract the appointment-push logic of addAppointment into a " +
            "private helper used by it, and add listReminders() returning every appointment " +
            "with reminded=true. Do NOT touch lib.test.mjs.",
        ],
        (log) => logs.push(log),
        signal,
      );
      const turn = logs[0];
      const idealHooks = (turn?.hooks ?? []).filter((hook) => hook === "ideal").length;
      const mentionsWork = /addAppointment|listReminders|helper/i.test(turn?.answer ?? "");
      const detail = [
        `hooks: [${turn?.hooks.join(", ") || "none"}] (ideal x${idealHooks})`,
        `answer: ${(turn?.answer ?? "").slice(0, 160)}`,
      ];
      const pass = idealHooks >= 1 && idealHooks <= 4 && mentionsWork;
      detail.unshift(
        pass
          ? "PASS — ideal review fired within budget, answer on-topic"
          : `FAIL — idealHooks=${idealHooks}, mentionsWork=${mentionsWork}`,
      );
      return { pass, detail };
    },
  },
];

const args = process.argv.slice(2);
const roundsFlag = args.indexOf("--rounds");
const rounds = roundsFlag >= 0 ? Math.max(1, Number(args[roundsFlag + 1]) || 1) : 1;
const scenarioFlag = args.indexOf("--scenario");
const only =
  scenarioFlag >= 0 && ["a", "b", "c"].includes(String(args[scenarioFlag + 1]))
    ? String(args[scenarioFlag + 1])
    : null;

const overall = new AbortController();
process.on("SIGINT", () => overall.abort());
let failures = 0;
for (let round = 1; round <= rounds; round++) {
  for (const scenario of SCENARIOS) {
    if (only && scenario.id !== only) continue;
    console.log(`\n===== scenario ${scenario.id} [${scenario.name}] round ${round} =====`);
    try {
      const { pass, detail } = await scenario.run(overall.signal);
      for (const line of detail) console.log(line);
      if (!pass) failures++;
    } catch (error) {
      failures++;
      console.log(`FAIL — exception: ${(error as Error).message}`);
    }
  }
}
console.log(`\n===== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} =====`);
process.exitCode = failures === 0 ? 0 : 1;
