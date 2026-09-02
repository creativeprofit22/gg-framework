// Steroids reliability bench: does the PRODUCTION system prompt make the agent
// treat the corpus as the source of truth — search before coding, fill a gap
// (discover → ask → add) on approval, and nudge honestly when the CLI is
// missing? Runs the real Agent loop against the real `steroids` binary with an
// isolated corpus root per scenario. Scratch experiment, excluded from CI.
//
//   ../../node_modules/.bin/tsx steroids-bench.ts -n 3 [--scenario gap,missing]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Agent, type AgentEvent, type AgentTool } from "@kenkaiiii/gg-agent";
import { buildSystemPrompt } from "@kenkaiiii/ggcoder";
import { loadAuth, type ModelTarget } from "./auth.js";
import { createSandbox, type TrajectoryEntry } from "./sandbox.js";
// Not on the package's public export map; the bench reaches into dist directly.
import { createSteroidsTool } from "../../packages/ggcoder/dist/tools/steroids.js";
import { findSteroidsBinary } from "../../packages/ggcoder/dist/core/steroids.js";

const TARGET: ModelTarget = { label: "glm-5.3", provider: "glm", model: "glm-5.3", authKey: "glm" };

interface Check {
  id: string;
  pass: (ctx: Ctx) => boolean;
}
interface Ctx {
  trajectory: TrajectoryEntry[];
  finalText: string;
}
interface Scenario {
  id: string;
  /** "real" = the user's corpus; "empty" = fresh temp root; "none" = binary hidden. */
  corpus: "real" | "empty" | "none";
  planMode: boolean;
  prompt: string;
  seed: Record<string, string>;
  checks: Check[];
}

const idx = (ctx: Ctx, pred: (t: TrajectoryEntry) => boolean) => ctx.trajectory.findIndex(pred);
const steroidsAction = (t: TrajectoryEntry, ...actions: string[]) =>
  t.tool === "steroids" && actions.includes(String(t.args.action));
const isCodeWrite = (t: TrajectoryEntry) =>
  (t.tool === "write" || t.tool === "edit") &&
  !String(t.args.file_path ?? "").startsWith(".gg/plans");
const firstCodeWrite = (ctx: Ctx) => idx(ctx, isCodeWrite);
const firstRead = (ctx: Ctx) => idx(ctx, (t) => steroidsAction(t, "search", "define", "show"));
const before = (a: number, b: number) => a >= 0 && b >= 0 && a < b;

const EXPRESS_SEED = {
  "package.json": JSON.stringify({ name: "api", type: "module", dependencies: { express: "^5.1.0" } }, null, 2),
  "src/server.ts": `import express from "express";\n\nexport const app = express();\napp.get("/health", (_req, res) => res.json({ ok: true }));\n`,
};

const RATE_LIMIT_PROMPT =
  "Add an in-memory token-bucket rate limiter middleware in src/rateLimit.ts and wire it onto every route in src/server.ts (60 requests/minute per client IP, 429 with Retry-After when exhausted). Nontrivial — get it right.";

const readsCorpusBeforeCoding: Check = {
  id: "corpus-read-before-first-write",
  pass: (ctx) => before(firstRead(ctx), firstCodeWrite(ctx)),
};
const wroteCode: Check = { id: "wrote-code", pass: (ctx) => firstCodeWrite(ctx) >= 0 };
const noBashSteroids: Check = {
  id: "no-bash-steroids-improvisation",
  pass: (ctx) =>
    !ctx.trajectory.some((t) => t.tool === "bash" && /\bsteroids\b/.test(String(t.args.command ?? ""))),
};

const SCENARIOS: Scenario[] = [
  {
    id: "hit",
    corpus: "real",
    planMode: false,
    prompt: RATE_LIMIT_PROMPT,
    seed: EXPRESS_SEED,
    checks: [
      readsCorpusBeforeCoding,
      {
        // A search hit with context lines IS real code; `show` is optional.
        id: "got-real-hits",
        pass: (ctx) => ctx.trajectory.some((t) => (steroidsAction(t, "show") && t.ok) || (steroidsAction(t, "search", "define") && /"count": [1-9]/.test(t.result))),
      },
      wroteCode,
      { id: "did-not-discover-with-hits", pass: (ctx) => !ctx.trajectory.some((t) => steroidsAction(t, "add")) },
    ],
  },
  {
    id: "gap",
    corpus: "empty",
    planMode: false,
    prompt: RATE_LIMIT_PROMPT,
    seed: EXPRESS_SEED,
    checks: [
      { id: "discovered", pass: (ctx) => idx(ctx, (t) => steroidsAction(t, "discover")) >= 0 },
      {
        id: "asked-before-indexing",
        pass: (ctx) => {
          const add = idx(ctx, (t) => steroidsAction(t, "add") || (steroidsAction(t, "discover") && t.args.add === true));
          const ask = idx(ctx, (t) => t.tool === "ask_user");
          return before(ask, add);
        },
      },
      {
        id: "indexed-after-approval",
        pass: (ctx) => ctx.trajectory.some((t) => (steroidsAction(t, "add") || (steroidsAction(t, "discover") && t.args.add === true)) && t.ok),
      },
      {
        id: "read-corpus-after-indexing",
        pass: (ctx) => {
          const add = idx(ctx, (t) => steroidsAction(t, "add") || (steroidsAction(t, "discover") && t.args.add === true));
          const read = ctx.trajectory.findIndex((t, i) => i > add && steroidsAction(t, "search", "define", "show") && t.ok);
          return before(add, read);
        },
      },
      readsCorpusBeforeCoding,
      wroteCode,
    ],
  },
  {
    id: "missing",
    corpus: "none",
    planMode: false,
    prompt: RATE_LIMIT_PROMPT,
    seed: EXPRESS_SEED,
    checks: [
      { id: "nudged-to-install", pass: (ctx) => /steroids/i.test(ctx.finalText) },
      noBashSteroids,
      wroteCode,
    ],
  },
  {
    id: "plan-hit",
    corpus: "real",
    planMode: true,
    prompt: RATE_LIMIT_PROMPT,
    seed: EXPRESS_SEED,
    checks: [
      {
        id: "corpus-read-before-plan-write",
        pass: (ctx) => before(firstRead(ctx), idx(ctx, (t) => t.tool === "write" && String(t.args.file_path).startsWith(".gg/plans"))),
      },
      { id: "wrote-plan", pass: (ctx) => ctx.trajectory.some((t) => t.tool === "write" && String(t.args.file_path).startsWith(".gg/plans")) },
      { id: "called-exit-plan", pass: (ctx) => ctx.trajectory.some((t) => t.tool === "exit_plan") },
      { id: "no-code-writes", pass: (ctx) => firstCodeWrite(ctx) < 0 },
      {
        id: "plan-cites-corpus",
        pass: (ctx) => {
          const plan = ctx.trajectory.find((t) => t.tool === "write" && String(t.args.file_path).startsWith(".gg/plans"));
          return !!plan && /steroids|corpus|[\w.-]+\/[\w.-]+/.test(String(plan.args.content ?? ""));
        },
      },
    ],
  },
  {
    id: "plan-missing",
    corpus: "none",
    planMode: true,
    prompt: RATE_LIMIT_PROMPT,
    seed: EXPRESS_SEED,
    checks: [
      { id: "wrote-plan", pass: (ctx) => ctx.trajectory.some((t) => t.tool === "write" && String(t.args.file_path).startsWith(".gg/plans")) },
      { id: "called-exit-plan", pass: (ctx) => ctx.trajectory.some((t) => t.tool === "exit_plan") },
      noBashSteroids,
      { id: "no-code-writes", pass: (ctx) => firstCodeWrite(ctx) < 0 },
    ],
  },
];

function recorded(trajectory: TrajectoryEntry[], tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(args, context) {
      const out = await tool.execute(args, context);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      trajectory.push({ tool: tool.name, args: args as Record<string, unknown>, ok: !/^Error:/.test(text), result: text.slice(0, 400) });
      return out;
    },
  };
}

/** Auto-approves: picks the recommended option, else the first. */
function askUserStub(trajectory: TrajectoryEntry[]): AgentTool {
  const Option = z.object({ label: z.string(), value: z.string().optional(), recommended: z.boolean().optional(), hint: z.string().optional() });
  return {
    name: "ask_user",
    description: "Ask the user a question and wait for their answer, rendered as clickable options. Use for decisions only (e.g. approving repos to index). Mark your pick `recommended`.",
    parameters: z.object({
      questions: z.array(z.object({ id: z.string(), question: z.string(), kind: z.enum(["confirm", "choice", "multi", "text"]), detail: z.string().optional(), options: z.array(Option).optional() })),
    }),
    execute: async (a) => {
      const { questions } = a as { questions: { id: string; kind: string; options?: z.infer<typeof Option>[] }[] };
      const answers = questions.map((q) => {
        if (q.kind === "confirm") return `${q.id}: yes`;
        if (q.kind === "text") return `${q.id}: go ahead with your recommendation`;
        const picks = q.kind === "multi" ? (q.options ?? []) : [q.options?.find((o) => o.recommended) ?? q.options?.[0]];
        return `${q.id}: ${picks.filter(Boolean).map((o) => o!.value ?? o!.label).join(", ")}`;
      });
      const out = `User answered:\n${answers.join("\n")}`;
      trajectory.push({ tool: "ask_user", args: a as Record<string, unknown>, ok: true, result: out.slice(0, 400) });
      return out;
    },
  };
}

function exitPlanStub(trajectory: TrajectoryEntry[]): AgentTool {
  return {
    name: "exit_plan",
    description: "Submit a .gg/plans/ markdown plan for user review and leave plan mode.",
    parameters: z.object({ plan_path: z.string() }),
    execute: async (a) => {
      trajectory.push({ tool: "exit_plan", args: a as Record<string, unknown>, ok: true, result: "submitted" });
      return "Plan submitted for review. Stop here.";
    },
  };
}

async function runOnce(s: Scenario): Promise<Ctx> {
  const auth = await loadAuth(TARGET.authKey);
  const sandbox = createSandbox(s.seed);
  const trajectory = sandbox.trajectory;
  const tools: AgentTool[] = [...sandbox.tools, askUserStub(trajectory), exitPlanStub(trajectory)];
  let corpusRoot: string | undefined;
  if (s.corpus !== "none") {
    const bin = findSteroidsBinary();
    if (!bin) throw new Error("steroids binary not found on this machine");
    if (s.corpus === "empty") {
      corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steroids-bench-"));
      process.env.STEROIDS_ROOT = corpusRoot;
    } else {
      delete process.env.STEROIDS_ROOT;
    }
    tools.push(recorded(trajectory, createSteroidsTool(bin)));
  }
  const system = await buildSystemPrompt(sandbox.root, undefined, s.planMode, undefined, tools.map((t) => t.name));
  let finalText = "";
  try {
    const agent = new Agent({
      provider: TARGET.provider,
      model: TARGET.model,
      system,
      tools,
      apiKey: auth.apiKey,
      accountId: auth.accountId,
      baseUrl: auth.baseUrl,
      maxTurns: 25,
      maxTokens: 8192,
      thinking: "low",
    });
    for await (const ev of agent.prompt(s.prompt) as AsyncIterable<AgentEvent>) {
      if (ev.type === "text_delta") finalText += ev.text;
      if (ev.type === "error") throw ev.error;
    }
    return { trajectory, finalText: finalText.trim() };
  } finally {
    sandbox.cleanup();
    if (corpusRoot) fs.rmSync(corpusRoot, { recursive: true, force: true });
    delete process.env.STEROIDS_ROOT;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let n = 3;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-n") n = Number(argv[++i]);
    if (argv[i] === "--scenario") only = argv[++i].split(",");
  }
  process.on("unhandledRejection", () => {});
  const summary: string[] = [];
  for (const s of SCENARIOS) {
    if (only && !only.includes(s.id)) continue;
    const pass: Record<string, number> = {};
    let errors = 0;
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      try {
        const ctx = await runOnce(s);
        const line = ctx.trajectory.map((t) => (t.tool === "steroids" ? `steroids:${t.args.action}${t.ok ? "" : "!"}` : t.tool)).join(" → ");
        const fails: string[] = [];
        for (const c of s.checks) {
          const ok = c.pass(ctx);
          pass[c.id] = (pass[c.id] ?? 0) + (ok ? 1 : 0);
          if (!ok) fails.push(c.id);
        }
        console.log(`[${s.id} #${i + 1}] ${((Date.now() - t0) / 1000).toFixed(0)}s ${fails.length ? "FAIL " + fails.join(",") : "ok"}\n  ${line}\n  final: ${ctx.finalText.replace(/\s+/g, " ").slice(0, 300)}`);
        if (fails.length) {
          for (const t of ctx.trajectory) {
            if (t.tool === "steroids" || t.tool === "ask_user") {
              console.log(`    ${t.tool}(${JSON.stringify(t.args).slice(0, 160)}) → ${t.result.replace(/\s+/g, " ").slice(0, 240)}`);
            }
          }
        }
      } catch (err) {
        errors++;
        console.log(`[${s.id} #${i + 1}] ERROR ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    summary.push(`${s.id}: errors=${errors}/${n} ` + s.checks.map((c) => `${c.id}=${pass[c.id] ?? 0}/${n}`).join(" "));
  }
  console.log("\n=== SUMMARY ===\n" + summary.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
