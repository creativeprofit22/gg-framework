#!/usr/bin/env node
// @ts-check
// Bench kit command line. The agent orchestrates and explains; this CLI does
// all the counting. Every command prints one JSON object on stdout:
//   { "ok": true, "command": "...", ...result }
//   { "ok": false, "command": "...", "error": { "code", "message", "details"? } }
// Exit codes: 0 ok, 1 refused or failed (expected), 2 usage error, 3 kit bug.
// Progress lines go to stderr (silence with --quiet).
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  addGlossaryTerm,
  explain,
  freeze,
  KIT_DIR,
  list,
  rateCreate,
  rateImport,
  report,
  run,
  validate,
} from "./lib/pipeline.mjs";
import { selftest } from "./lib/selftest.mjs";

export const USAGE = `Usage: node bench/kit/cli.mjs <command> [arguments] [options]

Commands:
  selftest                              check the kit is intact and works here
  validate <study>                      check bench/studies/<study>/study.json
  freeze <study>                        freeze the protocol (a change makes a new version)
  aa <study> [--run-id ID]              same-vs-same run that measures the noise floor
  run <study> [--run-id ID]             full run with the frozen repeats
  run <study> --pilot [--repeats N]     pilot run to size the study (never evidence)
  report <study> [--runs A,B] [--aa ID] report.md, verdict.json and a RESULTS.md entry
  explain <term | study | study:metric> plain-language explanation
  explain <term> --plain TEXT [--example TEXT] [--alias A,B] [--replace]
                                        add a term to bench/glossary.json
  rate <study> create <pack> [--run ID] [--scale MIN-MAX] [--prompt TEXT]
                                        blind rating pack from a run's outputs
  rate <study> import <pack> <scores.csv> [--metric ID]
                                        unblind filled-in scores
  list                                  every study and its latest verdict

Spend caps (aa and run; required when a candidate is paid):
  --cap-usd N           dollar cap a person approved for this run
  --cap-tokens N        optional token cap (needs budget.perSampleWorstCase.tokens)
  --approved-by TEXT    who approved the caps
  --approval-ref TEXT   where they approved it (e.g. the question and answer)

Options:
  --project DIR   project root (default: the current folder)
  --quiet         no progress lines on stderr
`;

const SPEND = Object.freeze({
  "cap-usd": true,
  "cap-tokens": true,
  "approved-by": true,
  "approval-ref": true,
});

/** Allowed options per command: true = takes a value, false = a switch. */
const OPTIONS = Object.freeze({
  selftest: {},
  validate: {},
  freeze: {},
  aa: { "run-id": true, ...SPEND },
  run: { "run-id": true, pilot: false, repeats: true, ...SPEND },
  report: { runs: true, aa: true },
  explain: { plain: true, example: true, alias: true, replace: false },
  rate: { run: true, scale: true, prompt: true, metric: true },
  list: {},
});
const GLOBAL = Object.freeze({ project: true, quiet: false, help: false });

/** Positional argument counts per command: [min, max]. @type {Readonly<Record<keyof typeof OPTIONS, readonly [number, number]>>} */
const POSITIONALS = Object.freeze({
  selftest: [0, 0],
  validate: [1, 1],
  freeze: [1, 1],
  aa: [1, 1],
  run: [1, 1],
  report: [1, 1],
  explain: [1, 1],
  rate: [3, 4],
  list: [0, 0],
});

class UsageError extends Error {}

/**
 * Parse argv into a command, positionals and options.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help")
    return { command: "help", positionals: [], options: {} };
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(`unknown command: ${command}`);
  const allowed = {
    ...OPTIONS[/** @type {keyof typeof OPTIONS} */ (command)],
    ...GLOBAL,
  };
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | true>} */
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = /** @type {string} */ (rest[i]);
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!Object.hasOwn(allowed, name)) throw new UsageError(`${command} does not take --${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`--${name} was given twice`);
    const takesValue = allowed[/** @type {keyof typeof allowed} */ (name)];
    if (!takesValue) {
      if (eq >= 0) throw new UsageError(`--${name} does not take a value`);
      options[name] = true;
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : rest[++i];
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    options[name] = value;
  }
  const [min, max] = POSITIONALS[/** @type {keyof typeof POSITIONALS} */ (command)];
  if (options.help) return { command: "help", positionals: [], options: {} };
  if (positionals.length < min || positionals.length > max)
    throw new UsageError(
      `${command} takes ${min === max ? min : `${min} to ${max}`} argument(s), got ${positionals.length}`,
    );
  return { command, positionals, options };
}

/** @param {string | true | undefined} v @param {string} name */
function intOption(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isInteger(n))
    throw new UsageError(`--${name} needs a whole number`);
  return n;
}

/** @param {string | true | undefined} v */
const listOption = (v) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

/** @param {string | true | undefined} v */
const textOption = (v) => (typeof v === "string" ? v : undefined);

/** @param {string | true | undefined} v @param {string} name */
function numberOption(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isFinite(n) || n <= 0)
    throw new UsageError(`--${name} needs a positive number`);
  return n;
}

/**
 * Spend caps from the command line, or nothing when none were given.
 * @param {Record<string, string | true>} options
 * @returns {{ budget?: Partial<import("./lib/budget.mjs").Approval> }}
 */
function budgetOption(options) {
  const usd = numberOption(options["cap-usd"], "cap-usd");
  const tokens = numberOption(options["cap-tokens"], "cap-tokens");
  const approvedBy = textOption(options["approved-by"]);
  const reference = textOption(options["approval-ref"]);
  if (usd === undefined) {
    if (tokens !== undefined || approvedBy || reference)
      throw new UsageError("--cap-tokens, --approved-by and --approval-ref need --cap-usd");
    return {};
  }
  return {
    budget: {
      usd,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(approvedBy ? { approvedBy } : {}),
      ...(reference ? { reference } : {}),
    },
  };
}

/** @param {string | true | undefined} v */
function scaleOption(v) {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(v) : null;
  if (!m) throw new UsageError("--scale needs MIN-MAX, e.g. 1-5");
  return { min: Number(m[1]), max: Number(m[2]) };
}

/**
 * Run one command and return its JSON result and exit code.
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, stderr?: (line: string) => void, now?: () => string, kitDir?: string }} [io]
 * @returns {Promise<{ code: number, output: Record<string, unknown> | string }>}
 */
export async function main(argv, io = {}) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError)
      return {
        code: 2,
        output: {
          ok: false,
          command: argv[0] ?? null,
          error: { code: "USAGE", message: error.message },
        },
      };
    throw error;
  }
  const { command, positionals, options } = parsed;
  if (command === "help") return { code: 0, output: USAGE };
  const quiet = options.quiet === true;
  const stderr = io.stderr ?? ((/** @type {string} */ line) => process.stderr.write(`${line}\n`));
  const projectDir = path.resolve(io.cwd ?? process.cwd(), textOption(options.project) ?? ".");
  /** @type {import("./lib/pipeline.mjs").Context} */
  const ctx = {
    projectDir,
    kitDir: io.kitDir ?? KIT_DIR,
    ...(io.now ? { now: io.now } : {}),
    ...(io.env ? { env: io.env } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    onProgress: (e) => {
      if (quiet || e.type !== "sample") return;
      const warm = e.phase === "warmup" ? " (warm-up)" : "";
      stderr(`[${e.done}/${e.total}] ${e.candidate} ${e.item}${warm}: ${e.status}`);
    },
  };
  const [first, second, third, fourth] = positionals;

  /** @type {import("./lib/result.mjs").Result<any>} */
  let result;
  try {
    switch (command) {
      case "selftest":
        result = await selftest({ kitDir: ctx.kitDir ?? KIT_DIR });
        break;
      case "validate":
        result = await validate(ctx, /** @type {string} */ (first));
        break;
      case "freeze":
        result = await freeze(ctx, /** @type {string} */ (first));
        break;
      case "aa":
        result = await run(ctx, /** @type {string} */ (first), {
          kind: "aa",
          ...(textOption(options["run-id"]) ? { runId: textOption(options["run-id"]) } : {}),
          ...budgetOption(options),
        });
        break;
      case "run": {
        const repeats = intOption(options.repeats, "repeats");
        if (repeats !== undefined && options.pilot !== true)
          throw new UsageError(
            "--repeats only applies to --pilot runs; full runs use the frozen repeats",
          );
        result = await run(ctx, /** @type {string} */ (first), {
          kind: options.pilot === true ? "pilot" : "full",
          ...(textOption(options["run-id"]) ? { runId: textOption(options["run-id"]) } : {}),
          ...(repeats !== undefined ? { repeats } : {}),
          ...budgetOption(options),
        });
        break;
      }
      case "report":
        result = await report(ctx, /** @type {string} */ (first), {
          ...(listOption(options.runs) ? { runs: listOption(options.runs) } : {}),
          ...(textOption(options.aa) ? { aa: textOption(options.aa) } : {}),
        });
        break;
      case "explain": {
        const plain = textOption(options.plain);
        if (plain === undefined) {
          if (options.example || options.alias || options.replace)
            throw new UsageError(
              "--example, --alias and --replace only apply when adding a term with --plain",
            );
          result = await explain(ctx, /** @type {string} */ (first));
        } else {
          const example = textOption(options.example);
          const aliases = listOption(options.alias);
          result = await addGlossaryTerm(ctx, /** @type {string} */ (first), {
            plain,
            ...(example ? { example } : {}),
            ...(aliases ? { aliases } : {}),
            replace: options.replace === true,
          });
        }
        break;
      }
      case "rate": {
        if (second === "create") {
          if (fourth !== undefined) throw new UsageError("rate create takes <study> create <pack>");
          if (options.metric) throw new UsageError("--metric applies to rate import");
          const scale = scaleOption(options.scale);
          result = await rateCreate(ctx, /** @type {string} */ (first), {
            packId: /** @type {string} */ (third),
            ...(textOption(options.run) ? { runId: textOption(options.run) } : {}),
            ...(scale ? { scale } : {}),
            ...(textOption(options.prompt) ? { prompt: textOption(options.prompt) } : {}),
          });
        } else if (second === "import") {
          if (fourth === undefined)
            throw new UsageError("rate import takes <study> import <pack> <scores.csv>");
          if (options.run || options.scale || options.prompt)
            throw new UsageError("--run, --scale and --prompt apply to rate create");
          result = await rateImport(ctx, /** @type {string} */ (first), {
            packId: /** @type {string} */ (third),
            scoresFile: fourth,
            ...(textOption(options.metric) ? { metric: textOption(options.metric) } : {}),
          });
        } else throw new UsageError("rate needs create or import");
        break;
      }
      case "list":
        result = await list(ctx);
        break;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError)
      return {
        code: 2,
        output: { ok: false, command, error: { code: "USAGE", message: error.message } },
      };
    return {
      code: 3,
      output: {
        ok: false,
        command,
        error: {
          code: "KIT_BUG",
          message: `the kit crashed; this is a bug, not a result: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        },
      },
    };
  }
  if (!result.ok)
    return {
      code: 1,
      output: {
        ok: false,
        command,
        error: {
          code: result.error.code,
          message: result.error.message,
          ...(result.error.details !== undefined ? { details: result.error.details } : {}),
        },
      },
    };
  return { code: 0, output: { ok: true, command, ...result.value } };
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("stopping after the current sample; the run will be marked aborted\n");
    controller.abort();
  });
  const { code, output } = await main(process.argv.slice(2), { signal: controller.signal });
  process.stdout.write(
    typeof output === "string" ? output : `${JSON.stringify(output, null, 2)}\n`,
  );
  process.exitCode = code;
}
