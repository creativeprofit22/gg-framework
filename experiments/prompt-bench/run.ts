import { Agent, type AgentEvent } from "@kenkaiiii/gg-agent";
import { loadAuth, TARGETS, type ModelTarget } from "./auth.js";
import { createSandbox } from "./sandbox.js";
import { SECTIONS, assemblePrompt, type SectionVariant } from "./variants.js";
import { tasksForSection, type BenchTask, type ScoreContext } from "./tasks.js";

// ── Config (override via CLI flags) ────────────────────────
interface Config {
  iterations: number;
  section: string | null;
  targets: string[] | null;
  /** Substring match on variant id (e.g. "full,preguard"). */
  variants: string[] | null;
  /** Substring match on task id (e.g. "question-not-fix,green-honestly"). */
  tasks: string[] | null;
}

function parseArgs(argv: string[]): Config {
  const cfg: Config = { iterations: 10, section: null, targets: null, variants: null, tasks: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iterations" || a === "-n") cfg.iterations = Number(argv[++i]);
    else if (a === "--section" || a === "-s") cfg.section = argv[++i] ?? null;
    else if (a === "--targets" || a === "-t") cfg.targets = (argv[++i] ?? "").split(",");
    else if (a === "--variant" || a === "-v") cfg.variants = (argv[++i] ?? "").split(",");
    else if (a === "--task") cfg.tasks = (argv[++i] ?? "").split(",");
  }
  return cfg;
}

interface CellResult {
  /** per-check pass counts across iterations */
  checkPass: Record<string, number>;
  iterations: number;
  errors: number;
}

async function runOnce(
  target: ModelTarget,
  systemPrompt: string,
  task: BenchTask,
): Promise<ScoreContext> {
  const auth = await loadAuth(target.authKey);
  const sandbox = createSandbox(task.seed);
  let finalText = "";
  try {
    const agent = new Agent({
      provider: target.provider,
      model: target.model,
      system: systemPrompt,
      tools: sandbox.tools,
      apiKey: auth.apiKey,
      accountId: auth.accountId,
      baseUrl: auth.baseUrl,
      maxTurns: 15,
      maxTokens: 4096,
      thinking: "low",
    });

    const stream = agent.prompt(task.prompt);
    // The for-await below throws when the event stream aborts on a provider
    // error, so it's caught by runOnce's caller. AgentStream's separate result
    // promise also rejects with no awaiter; that stray rejection is swallowed
    // by the process-level unhandledRejection handler installed in main().
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      if (ev.type === "text_delta") finalText += ev.text;
      if (ev.type === "error") throw ev.error;
    }
    return { trajectory: sandbox.trajectory, finalText: finalText.trim() };
  } finally {
    sandbox.cleanup();
  }
}

function score(ctx: ScoreContext, task: BenchTask, cell: CellResult): void {
  for (const check of task.checks) {
    cell.checkPass[check.id] ??= 0;
    try {
      if (check.pass(ctx)) cell.checkPass[check.id]++;
    } catch {
      // a throwing check counts as a fail
    }
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "  -  ";
  return `${Math.round((n / d) * 100)}%`.padStart(4);
}

async function main(): Promise<void> {
  // A stray provider rejection in one cell must not abort the whole bench run.
  process.on("unhandledRejection", (reason) => {
    console.error(
      `  (suppressed unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)})`,
    );
  });

  const cfg = parseArgs(process.argv.slice(2));
  const targets = TARGETS.filter((t) => !cfg.targets || cfg.targets.includes(t.label));
  const sections = SECTIONS.filter((s) => !cfg.section || s.key === cfg.section);
  const pickVariants = (s: (typeof SECTIONS)[number]) =>
    s.variants.filter((v) => !cfg.variants || cfg.variants.some((f) => v.id.includes(f)));

  console.log(
    `prompt-bench — ${cfg.iterations} iterations/cell · targets: ${targets.map((t) => t.label).join(", ")}\n`,
  );

  for (const section of sections) {
    const tasks = tasksForSection(section.key).filter(
      (t) => !cfg.tasks || cfg.tasks.some((f) => t.id.includes(f)),
    );
    if (tasks.length === 0) continue;

    console.log(`\n══ SECTION: ${section.key} ══`);

    for (const target of targets) {
      console.log(`\n  model: ${target.label}`);

      for (const task of tasks) {
        const header = `    task ${task.id}`;
        console.log(header);

        // baseline = first variant (the .full one)
        for (const variant of pickVariants(section)) {
          const systemPrompt = assemblePrompt(section.key, variant);
          const cell: CellResult = { checkPass: {}, iterations: 0, errors: 0 };

          for (let i = 0; i < cfg.iterations; i++) {
            try {
              const ctx = await runOnce(target, systemPrompt, task);
              score(ctx, task, cell);
              cell.iterations++;
            } catch (err) {
              cell.errors++;
              if (cell.errors === 1) {
                console.log(
                  `      ! ${variant.id} error: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }

          const checkSummary = task.checks
            .map((c) => `${c.id}=${pct(cell.checkPass[c.id] ?? 0, cell.iterations)}`)
            .join("  ");
          console.log(
            `      ${variant.id.padEnd(20)} ${String(variant.words).padStart(3)}w  ` +
              `n=${cell.iterations}${cell.errors ? `(+${cell.errors} err)` : ""}  ${checkSummary}`,
          );
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { SectionVariant };
