// Reproduction + candidate test for the "duplicate final summary" pattern: a
// follow-up user message triggers an edit, the verification gate injects a
// recheck, and the model re-answers with a near-copy of its previous checklist.
// Two arms: baseline (production gate wording) vs refined (delta-only recheck
// instruction). No production behavior changes.
// pnpm exec tsx experiments/prompt-bench/duplicate-summary-sim.ts [--arm baseline|refined]
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Message } from "@kenkaiiii/gg-ai";
import { Agent } from "../../packages/gg-agent/src/agent.js";
import type { AgentTool } from "../../packages/gg-agent/src/types.js";
import { buildSystemPrompt } from "../../packages/ggcoder/src/system-prompt.js";
import { VerificationGate } from "../../packages/ggcoder/src/core/verification-gate.js";
import { loadAuth, type BenchAuth } from "./auth.js";

const exec = promisify(execFile);
const CHECK_COMMAND = "node --test portal.test.mjs";
const TOOL_NAMES = ["read", "edit", "bash"];

const PORTAL = `export const portal = { appointments: [], consents: [] };

export function addAppointment(patient, when) {
  portal.appointments.push({ patient, when, reminded: false });
  return portal.appointments.length;
}

export function recordConsent(patient, kind) {
  portal.consents.push({ patient, kind, at: new Date().toISOString() });
  return portal.consents.length;
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { portal, addAppointment, recordConsent } from './portal.mjs';

test('appointments', () => {
  assert.equal(addAppointment('ada', '2026-09-10T09:00Z'), 1);
  assert.equal(portal.appointments[0].reminded, false);
});

test('consents', () => {
  assert.equal(recordConsent('ada', 'treatment'), 1);
  assert.equal(portal.consents[0].kind, 'treatment');
});
`;

// The follow-up that produced the real-world duplicate, verbatim.
const CONSENT_FOLLOW_UP = "It has a consent being updated in the patient portal as well.";

/** Mirrors the production recheck wording in verification-gate.ts — the arm exists
 * to A/B that instruction against the pre-injection behavior. */
const DELTA_ONLY_INSTRUCTION =
  "\nThis is a re-verification after a follow-up change, not a new report: the full " +
  "checklist was already summarized earlier in this conversation. Do not repeat that " +
  "summary or its structure. Once the affected checks pass again, reply briefly as a " +
  "delta — name only the change that was just re-verified and confirm the checks still " +
  "pass (for example: \"Re-verified <change> — the affected checks still pass.\"). " +
  "Repeat the full checklist only if something actually broke.";

interface TurnResult {
  summary: string;
  hookNotices: string[];
  edits: number;
  checks: number;
  messages: Message[];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(text: string): string[] {
  const words = text.split(" ").filter(Boolean);
  return words.slice(0, -1).map((word, i) => `${word} ${words[i + 1]}`);
}

/** 0..1 overlap of adjacent word pairs — high means "reads like the same text". */
function dice(textA: string, textB: string): number {
  const a = bigrams(textA);
  const b = bigrams(textB);
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const gram of b) pool.set(gram, (pool.get(gram) ?? 0) + 1);
  let hits = 0;
  for (const gram of a) {
    const left = pool.get(gram) ?? 0;
    if (left > 0) {
      hits++;
      pool.set(gram, left - 1);
    }
  }
  return (2 * hits) / (a.length + b.length);
}

function jaccard(textA: string, textB: string): number {
  const a = new Set(normalize(textA).split(" ").filter(Boolean));
  const b = new Set(normalize(textB).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

async function runTurn(opts: {
  arm: "baseline" | "refined";
  cwd: string;
  gate: VerificationGate;
  source: { text: string };
  auth: BenchAuth;
  system: string;
  prior: Message[];
  user: string;
  signal: AbortSignal;
}): Promise<TurnResult> {
  const { arm, cwd, gate, source, auth, system, prior, user, signal } = opts;
  gate.beginRun(); // Mirrors agent-session: per-run injection budgets reset.
  const hookNotices: string[] = [];
  let edits = 0;
  let checks = 0;

  const tools: AgentTool[] = [
    {
      name: "read",
      description: "Read a fixture file (portal.mjs or portal.test.mjs).",
      parameters: z.object({ file_path: z.enum(["portal.mjs", "portal.test.mjs"]) }),
      execute: async (args) => {
        const { file_path } = z
          .object({ file_path: z.enum(["portal.mjs", "portal.test.mjs"]) })
          .parse(args);
        return file_path === "portal.mjs"
          ? source.text
          : await (await import("node:fs/promises")).readFile(
              path.join(cwd, file_path),
              "utf8",
            );
      },
    },
    {
      name: "edit",
      executionMode: "sequential",
      description: "Replace exact text in portal.mjs. Tests are immutable.",
      parameters: z.object({
        file_path: z.literal("portal.mjs"),
        old_text: z.string().max(4000),
        new_text: z.string().max(4000),
      }),
      execute: async (args) => {
        const patch = z.object({ old_text: z.string(), new_text: z.string() }).parse(args);
        if (!source.text.includes(patch.old_text)) throw new Error("old_text not found");
        source.text = source.text.replace(patch.old_text, patch.new_text);
        await writeFile(path.join(cwd, "portal.mjs"), source.text);
        edits++;
        gate.recordMutation("portal.mjs");
        return "Edit applied. Any earlier verification predates this edit.";
      },
    },
    {
      name: "bash",
      executionMode: "sequential",
      description: "Run the portal test suite. No other commands are permitted.",
      parameters: z.object({ command: z.string().regex(/^node --test( portal\.test\.mjs)?$/) }),
      execute: async () => {
        checks++;
        const gateRevision = gate.revision;
        try {
          const result = await exec(process.execPath, ["--test", "portal.test.mjs"], {
            cwd,
            signal,
            timeout: 20_000,
            maxBuffer: 32_768,
          });
          gate.recordVerification(gateRevision, CHECK_COMMAND);
          return `Exit code: 0\n${result.stdout.slice(0, 500)}\n2 passing.`;
        } catch (error) {
          gate.recordFailedVerification(CHECK_COMMAND, gateRevision);
          const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
          return `Exit code: 1\n${(stdout + stderr).slice(0, 500)}`;
        }
      },
    },
  ];

  const agent = new Agent({
    provider: "glm",
    model: "glm-5.3",
    ...auth,
    system,
    priorMessages: prior,
    tools,
    thinking: "low",
    maxTokens: 1200,
    maxTurns: 8,
    maxTurnExtensions: 0,
    signal,
    getFollowUpMessages: () => {
      const reason = gate.pendingReason();
      const followUp = gate.followUp();
      if (!followUp) return null;
      hookNotices.push(reason === "recheck" ? "recheck" : reason ?? "other");
      if (arm === "refined" && reason === "recheck") {
        const first = followUp[0]!;
        followUp[0] = {
          role: "user",
          ...(first.provenance ? { provenance: first.provenance } : {}),
          content:
            (typeof first.content === "string" ? first.content : "") + DELTA_ONLY_INSTRUCTION,
        };
      }
      return followUp;
    },
  });

  const stream = agent.prompt(user);
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
    }
  } catch {
    /* stream errors surface via the awaited completion below */
  }
  const done = await stream.then(
    (value) => value,
    () => null,
  );
  const last = [...agent.getMessages()]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        (typeof message.content === "string"
          ? message.content.trim().length > 0
          : message.content.some((part) => part.type === "text" && part.text.trim().length > 0)),
    );
  const summary =
    typeof last?.content === "string"
      ? last.content
      : (last?.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") ?? "");
  return { summary, hookNotices, edits, checks, messages: agent.getMessages() };
}

async function runArm(
  arm: "baseline" | "refined",
  auth: BenchAuth,
  signal: AbortSignal,
  round: number,
): Promise<{ fullHooks: boolean; dice: number; jaccard: number }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-dupesim-"));
  const source = { text: PORTAL };
  await writeFile(path.join(cwd, "portal.mjs"), PORTAL);
  await writeFile(path.join(cwd, "portal.test.mjs"), TEST);
  const gate = new VerificationGate();
  // Seed verified state, mirroring the real session: work was already checked
  // before the turns that produced the duplicate summaries.
  await exec(process.execPath, ["--test", "portal.test.mjs"], { cwd, timeout: 20_000 });
  gate.recordVerification(gate.revision, CHECK_COMMAND);
  const system = await buildSystemPrompt(cwd, undefined, false, undefined, TOOL_NAMES);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  const turnSignal = AbortSignal.any([signal, controller.signal]);

  console.log(`\n================ arm: ${arm} round ${round} ================`);
  try {
    // Turn 1 — a routine follow-up request. Edit -> recheck injection -> summary A.
    const t1 = await runTurn({
      arm,
      cwd,
      gate,
      source,
      auth,
      system,
      prior: [],
      user:
        "Patients need to cancel appointments. Add a cancelAppointment(patient) function " +
        "to portal.mjs that removes the patient's first appointment and returns true, or " +
        "false if they had none. Work strictly in this order: (1) implement it, (2) run the " +
        "test suite and confirm it is green, (3) only then add a `@returns {boolean}` " +
        "JSDoc line above the new function. Do not run the suite again after step 3.",
      signal: turnSignal,
    });
    console.log(`\n--- turn 1 (${t1.edits} edits, ${t1.checks} checks, hooks: ${t1.hookNotices.join(",") || "none"})`);
    console.log(t1.summary);

    // Turn 2 — the verbatim follow-up from the real-world report.
    const prior = [...t1.messages, { role: "user", content: CONSENT_FOLLOW_UP } as Message];
    const t2 = await runTurn({
      arm,
      cwd,
      gate,
      source,
      auth,
      system,
      prior,
      user:
        CONSENT_FOLLOW_UP +
        " So: recordConsent should update an existing consent's kind in place (keeping " +
        "the original timestamp) instead of appending a duplicate entry. Same strict order " +
        "as before: (1) implement, (2) run the suite and confirm green, (3) add a one-line " +
        "comment above recordConsent last. Do not run the suite again after step 3.",
      signal: turnSignal,
    });
    console.log(`\n--- turn 2 (${t2.edits} edits, ${t2.checks} checks, hooks: ${t2.hookNotices.join(",") || "none"})`);
    console.log(t2.summary);

    const d = dice(t1.summary, t2.summary);
    const j = jaccard(t1.summary, t2.summary);
    const fullHooks =
      t1.hookNotices.includes("recheck") && t2.hookNotices.includes("recheck");
    console.log(
      `\nsimilarity  dice=${(d * 100).toFixed(0)}%  jaccard=${(j * 100).toFixed(0)}%  ` +
        `recheck-fired-both-turns=${fullHooks}`,
    );
    return { fullHooks, dice: d, jaccard: j };
  } finally {
    clearTimeout(timeout);
    const { rm } = await import("node:fs/promises");
    await rm(cwd, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const armFlag = args.indexOf("--arm");
const singleArm =
  armFlag >= 0 && (args[armFlag + 1] === "baseline" || args[armFlag + 1] === "refined")
    ? (args[armFlag + 1] as "baseline" | "refined")
    : null;
const roundsFlag = args.indexOf("--rounds");
const rounds = roundsFlag >= 0 ? Math.max(1, Number(args[roundsFlag + 1]) || 1) : 1;
const auth = await loadAuth("glm");
const overall = new AbortController();
process.on("SIGINT", () => overall.abort());
const results: Record<"baseline" | "refined", { fullHooks: boolean; dice: number; jaccard: number }[]> = {
  baseline: [],
  refined: [],
};
for (let round = 1; round <= rounds; round++) {
  for (const arm of singleArm ? [singleArm] : (["baseline", "refined"] as const)) {
    results[arm].push(await runArm(arm, auth, overall.signal, round));
  }
}
if (rounds > 1 || !singleArm) {
  console.log(`\n================ aggregate ================`);
  for (const arm of ["baseline", "refined"] as const) {
    const runs = results[arm];
    if (runs.length === 0) continue;
    const full = runs.filter((run) => run.fullHooks);
    const dupes = full.filter((run) => run.dice > 0.6).length;
    const sorted = [...runs].sort((a, b) => a.dice - b.dice);
    const median = sorted[Math.floor(sorted.length / 2)]!.dice;
    console.log(
      `${arm}: rounds=${runs.length} recheck-both-turns=${full.length}/${runs.length} ` +
        `near-duplicates(dice>60%)=${dupes}/${full.length || 0} median-dice=${(median * 100).toFixed(0)}%`,
    );
  }
}
