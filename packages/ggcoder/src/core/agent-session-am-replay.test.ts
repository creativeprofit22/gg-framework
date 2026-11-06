// Connected replay of the supa "AM" session pattern: a real AgentSession and agent
// loop against a scripted palsu provider, on a fixture monorepo with a TS package
// and a slow, silent Rust-like gate. GG_AM_REPLAY_REALTIME=1 runs it with the real
// limits (120 s yield, 600 s quiet budget, 60 min hard limit) and a 13-minute gate.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerPalsuProvider,
  palsuText,
  palsuToolCall,
  type AssistantMessage,
  type PalsuProviderHandle,
  type PalsuResponseFactory,
} from "@kenkaiiii/gg-ai";
import type { GitHubCI } from "@kenkaiiii/gg-core/desktop-session-ux";
import { useFakeHome } from "../test-support/fake-home.js";
import { createCINotStartedNotify } from "../utils/github-ci.js";
import { verifyPlanApproval } from "./verify-plan-approval.js";

const REALTIME = process.env.GG_AM_REPLAY_REALTIME === "1";
const WIN = process.platform === "win32";
// Scaled: the gate must outlast the yield (Windows never yields before 10 s) and
// its own quiet budget, which also acts as the pre-move inactivity limit.
const QUIET_SECONDS = REALTIME ? 600 : WIN ? 12 : 2;
const SILENT_GATE_SECONDS = REALTIME ? 13 * 60 : WIN ? 18 : 4;
const PRIOR_PASS = "Same check passed with identical inputs";
const STILL_CURRENT = "it is still current evidence, so this re-run is optional.";

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let shimDir: string;
let cargoLog: string;
let originalPath: string | undefined;
const savedEnv = new Map<string, string | undefined>();
let palsu: PalsuProviderHandle;

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function posix(file: string): string {
  return file.replace(/\\/g, "/");
}

async function write(rel: string, content: string | Buffer): Promise<void> {
  const file = path.join(tmpProject, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args],
    { cwd: tmpProject, stdio: "ignore" },
  );
}

/**
 * Fake cargo: logs every run, and on the first run stays silent for `silentSeconds`.
 * With `failMarker` present it fails instead; `echoEnv` prints the concurrency env.
 */
async function writeCargoShim(
  options: { silentSeconds?: number; failMarker?: string; echoEnv?: boolean } = {},
): Promise<void> {
  const silent = options.silentSeconds ?? 0;
  const firstMarker = path.join(shimDir, "cargo-first-done");
  const sh = [
    "#!/bin/sh",
    `echo "cargo $*" >> "${posix(cargoLog)}"`,
    silent > 0
      ? `if [ ! -f "${posix(firstMarker)}" ]; then touch "${posix(firstMarker)}"; sleep ${silent}; fi`
      : "",
    options.echoEnv
      ? 'echo "env CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-unset} RUST_TEST_THREADS=${RUST_TEST_THREADS:-unset}"'
      : "",
    options.failMarker
      ? `if [ -f "${posix(options.failMarker)}" ]; then echo "test result: FAILED. 2 passed; 1 failed"; exit 101; fi`
      : "",
    'echo "test result: ok. 3 passed; 0 failed"',
    "",
  ]
    .filter((line, index, all) => line !== "" || index === all.length - 1)
    .join("\n");
  await fs.writeFile(path.join(shimDir, "cargo"), sh, { encoding: "utf-8", mode: 0o755 });
  const cmd = [
    "@echo off",
    `echo cargo %*>> "${cargoLog}"`,
    silent > 0
      ? `if not exist "${firstMarker}" ( type nul > "${firstMarker}" & ping -n ${silent + 1} 127.0.0.1 >nul )`
      : "",
    options.echoEnv
      ? "echo env CARGO_BUILD_JOBS=%CARGO_BUILD_JOBS% RUST_TEST_THREADS=%RUST_TEST_THREADS%"
      : "",
    options.failMarker
      ? `if exist "${options.failMarker}" ( echo test result: FAILED. 2 passed; 1 failed & exit /b 101 )`
      : "",
    "echo test result: ok. 3 passed; 0 failed",
    "",
  ]
    .filter((line, index, all) => line !== "" || index === all.length - 1)
    .join("\r\n");
  await fs.writeFile(path.join(shimDir, "cargo.cmd"), cmd, "utf-8");
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(tmpHome, ".gg", "settings.json"), JSON.stringify(settings), "utf-8");
}

/** Approved `.gg/verify-plan.json` whose command prints `plan`. */
async function writeApprovedPlan(
  plan: Record<string, unknown>,
  extraSettings: Record<string, unknown> = {},
): Promise<void> {
  await write("plan.mjs", `process.stdout.write(${JSON.stringify(JSON.stringify(plan))});\n`);
  const descriptor = JSON.stringify({
    version: 1,
    command: { argv: [process.execPath, "plan.mjs"] },
    format: "gg-verify-plan-v1",
  });
  await write(".gg/verify-plan.json", descriptor);
  await writeSettings({
    ...extraSettings,
    verifyPlanApprovals: [verifyPlanApproval(tmpProject, descriptor)],
  });
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-am-replay-home-"));
  tmpProject = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), "gg-am-replay-project-")));
  shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-am-replay-bin-"));
  cargoLog = path.join(shimDir, "cargo-runs.txt");
  restoreHome = useFakeHome(tmpHome);
  palsu = registerPalsuProvider();
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      palsu: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }),
    "utf-8",
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  // The machine's own cargo home or concurrency env must not leak into the fixture.
  setEnv("CARGO_HOME", path.join(tmpHome, ".cargo"));
  setEnv("CARGO_BUILD_JOBS", undefined);
  setEnv("RUST_TEST_THREADS", undefined);
});

afterEach(async () => {
  process.env.PATH = originalPath;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  palsu.unregister();
  restoreHome?.();
  // Windows can keep a just-released dir busy for a moment under load.
  const rmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
  await fs.rm(tmpHome, rmOptions);
  await fs.rm(tmpProject, rmOptions);
  await fs.rm(shimDir, rmOptions);
});

async function cargoRuns(): Promise<string[]> {
  const raw = await fs.readFile(cargoLog, "utf-8").catch(() => "");
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

type Messages = Parameters<PalsuResponseFactory>[0];

interface ToolResult {
  text: string;
}

function toolResults(messages: unknown[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ content?: unknown }>) {
      const content = part.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((item: { text?: unknown }) => (typeof item.text === "string" ? item.text : ""))
                .join("")
            : JSON.stringify(content ?? "");
      results.push({ text });
    }
  }
  return results;
}

function resultsFor(messages: unknown[], command: string): string[] {
  return toolResults(messages)
    .map((result) => result.text)
    .filter((text) => text.includes(`Command: ${command}`));
}

function lastResult(messages: unknown[]): string {
  return toolResults(messages).at(-1)?.text ?? "";
}

function handedOffTaskId(text: string): string | null {
  const match = /moved to background task (\S+?)[\s.,;]/.exec(text);
  return match?.[1] ?? null;
}

/** A scripted step: a reply, or null when the step is finished and the next one runs. */
interface Step {
  reply: (messages: Messages) => AssistantMessage | null;
  /** Finished after its first reply. */
  oneShot: boolean;
}

function once(reply: AssistantMessage | ((messages: Messages) => AssistantMessage)): Step {
  return {
    reply: (messages) => (typeof reply === "function" ? reply(messages) : reply),
    oneShot: true,
  };
}

/** Polls task_output until the background task the last bash call moved has exited. */
function pollUntilExited(): Step {
  let taskId: string | null = null;
  return {
    oneShot: false,
    reply: (messages) => {
      const last = lastResult(messages);
      if (taskId === null) {
        taskId = handedOffTaskId(last);
        if (taskId === null) return null; // finished in the foreground
      } else if (last.startsWith(`Process ${taskId}: exited`)) {
        return null;
      }
      return palsuToolCall("task_output", { id: taskId, wait_ms: 600_000 });
    },
  };
}

/**
 * Feeds steps to palsu one model call at a time, so a poll can repeat as often as
 * needed. `calls` counts scripted replies; any extra palsu call is an unscripted turn.
 */
function runScript(steps: Step[]): { calls: () => number; remaining: () => number } {
  const queue = [...steps];
  let calls = 0;
  const driver = (messages: Messages): AssistantMessage => {
    while (queue.length > 0) {
      const step = queue[0]!;
      const reply = step.reply(messages);
      if (reply === null || step.oneShot) queue.shift();
      if (reply === null) continue;
      calls += 1;
      if (queue.length > 0) palsu.appendResponses(driver);
      return reply;
    }
    return palsuText("(script exhausted)");
  };
  palsu.appendResponses(driver);
  return {
    calls: () => calls,
    remaining: () => queue.length,
  };
}

async function newSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "palsu",
    model: "claude-sonnet-5-5", // real id so registry lookups succeed; palsu ignores it
    cwd: tmpProject,
    systemPrompt: "test system prompt",
  });
  await session.initialize();
  return session;
}

describe("supa AM replay on a fixture monorepo", () => {
  beforeEach(async () => {
    const tsMarker = path.join(shimDir, "ts-first-done");
    await write("package.json", JSON.stringify({ name: "fixture", private: true }) + "\n");
    await write("packages/app/src/a.ts", "export const a = 1;\n");
    // First run fails only by vitest-style timeouts (overload shape); later runs pass.
    await write(
      "scripts/ts-check.mjs",
      [
        'import fs from "node:fs";',
        `const marker = ${JSON.stringify(tsMarker)};`,
        "if (!fs.existsSync(marker)) {",
        '  fs.writeFileSync(marker, "1");',
        '  for (const name of ["a", "b", "c"]) {',
        "    console.log(` FAIL  src/${name}.test.ts > ${name} > waits`);",
        '    console.log("Error: Test timed out in 5000ms.");',
        "  }",
        '  console.log("      Tests  3 failed | 40 passed (43)");',
        "  process.exit(1);",
        "}",
        'console.log("      Tests  43 passed (43)");',
        "",
      ].join("\n"),
    );
    await write("crates/core/src/lib.rs", "pub fn core() -> u32 { 1 }\n");
    await write("docs/evidence/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await write(
      "scripts/shot.mjs",
      'import fs from "node:fs";\nfs.writeFileSync("docs/evidence/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));\nconsole.log("screenshot saved");\n',
    );
    await writeCargoShim({ silentSeconds: SILENT_GATE_SECONDS });
    await writeApprovedPlan(
      {
        version: 1,
        mode: "changed",
        gates: [
          { id: "ts", argv: ["node", "scripts/ts-check.mjs"], covers: ["packages/app/**"] },
          {
            id: "rust",
            argv: ["cargo", "test"],
            covers: ["crates/**"],
            quietBudgetSeconds: QUIET_SECONDS,
            protectedPaths: ["docs/evidence/**"],
          },
        ],
      },
      REALTIME ? {} : { bashYieldSeconds: 1 },
    );
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
  });

  it(
    `edit, plan-scoped check, git status, ${SILENT_GATE_SECONDS}s silent gate, caught re-run, protected change, overload flag, CI notice`,
    async () => {
      const session = await newSession();
      const ciNow = Date.parse("2026-10-31T09:00:00Z");
      const notifyCI = createCINotStartedNotify(() => session, { now: () => ciNow });
      const ci: GitHubCI = {
        key: "fixture-ci",
        url: "https://github.com/example/fixture/actions",
        total: 2,
        completed: 2,
        failed: 0,
        active: false,
        conclusion: "not_started",
        lastSuccessAt: "2026-10-20T08:00:00Z",
        notStartedStreak: 4,
      };
      let finalTurnSaw = "";
      const script = runScript([
        once(
          palsuToolCall("write", {
            file_path: path.join(tmpProject, "packages", "app", "src", "a.ts"),
            content: "export const a = 2;\n",
          }),
        ),
        once(palsuToolCall("bash", { command: "node scripts/ts-check.mjs" })),
        once(palsuToolCall("bash", { command: "node scripts/ts-check.mjs" })),
        once(palsuToolCall("bash", { command: "git status --short" })),
        once(palsuToolCall("bash", { command: "cargo test" })),
        pollUntilExited(),
        once(palsuToolCall("bash", { command: "cargo test" })),
        pollUntilExited(),
        once(() => {
          // The poller publishes while the agent works; a repeat must stay silent.
          notifyCI(ci);
          notifyCI(ci);
          return palsuToolCall("bash", { command: "node scripts/shot.mjs" });
        }),
        once((messages) => {
          finalTurnSaw = JSON.stringify(messages);
          return palsuText("Done: a is 2, both gates pass, screenshot refreshed.");
        }),
      ]);

      try {
        await session.prompt("Set a to 2, run the plan's gates and refresh the screenshot.");
        const messages = session.getMessages();

        const ts = resultsFor(messages, "node scripts/ts-check.mjs");
        expect(ts).toHaveLength(2);
        expect(ts[0]).toContain("the machine may have been overloaded");
        expect(ts[1]).not.toContain("overloaded");

        const cargo = resultsFor(messages, "cargo test");
        expect(cargo).toHaveLength(2);
        expect(cargo[0]).toContain("moved to background task");
        expect(cargo[0]).not.toContain(PRIOR_PASS);
        expect(cargo[1]).toContain(PRIOR_PASS);
        expect(cargo[1]).toContain(STILL_CURRENT);

        // The silent gate survived its quiet budget and exited on its own.
        const [gateTask] = session
          .listBackgroundProcesses()
          .filter((task) => task.command.includes("cargo test"));
        expect(gateTask).toBeDefined();
        expect(gateTask?.exitCode).toBe(0);
        expect(gateTask?.stopReason ?? null).toBeNull();
        const gateOutput = toolResults(messages)
          .map((result) => result.text)
          .filter((text) => text.startsWith(`Process ${gateTask?.id}:`));
        expect(gateOutput.at(-1)).toContain("exited (code 0");
        expect(gateOutput.join("\n")).not.toContain("stopped:");

        const shot = resultsFor(messages, "node scripts/shot.mjs");
        expect(shot).toHaveLength(1);
        expect(shot[0]).toContain("docs/evidence/a.png (modified, protected)");

        const notice = "GitHub refused to start the last 4 runs";
        expect(finalTurnSaw).toContain(notice);
        expect(finalTurnSaw.split(notice)).toHaveLength(2);

        expect(session.getVerificationProblem()).toBeNull();
        const evidence = session.getVerificationEvidenceLedgerSnapshot().currentEvidence;
        const passed = (command: string) =>
          evidence.filter((entry) => entry.command === command && entry.status === "passed");
        expect(passed("node scripts/ts-check.mjs").length).toBeGreaterThan(0);
        expect(passed("cargo test").length).toBeGreaterThan(0);
        expect(JSON.stringify(evidence)).not.toContain("GitHub");

        // No harness-driven gate re-run and no unscripted (nudge) turn.
        expect(await cargoRuns()).toHaveLength(2);
        expect(script.remaining()).toBe(0);
        expect(palsu.getPendingResponseCount()).toBe(0);
        expect(palsu.state.callCount).toBe(script.calls());
      } finally {
        await session.dispose();
      }
    },
    REALTIME ? 40 * 60_000 : 180_000,
  );
});

describe("connected regressions", () => {
  beforeEach(async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("crates/core/src/lib.rs", "pub fn core() -> u32 { 1 }\n");
    git("init", "-q");
  });

  it("a failing check is never replaced by the older pass", async () => {
    const failMarker = path.join(shimDir, "cargo-fails");
    await writeCargoShim({ failMarker });
    await writeApprovedPlan({
      version: 1,
      mode: "changed",
      gates: [{ id: "rust", argv: ["cargo", "test"], covers: ["crates/**"] }],
    });
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const session = await newSession();
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(() => {
      void fs.writeFile(failMarker, "1");
      return palsuToolCall("bash", { command: "cargo test" });
    });
    // An edit outside the gate's covers must not revive the earlier pass.
    palsu.appendResponses(
      palsuToolCall("write", {
        file_path: path.join(tmpProject, "src", "a.ts"),
        content: "export const a = 2;\n",
      }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuText("Done."));

    try {
      await fs.rm(failMarker, { force: true });
      await session.prompt("Run the Rust gate twice, edit a, run it again.");
      const cargo = resultsFor(session.getMessages(), "cargo test");
      expect(cargo).toHaveLength(3);
      expect(cargo[1]).toContain("FAILED");
      // After the failure no notice may call the old pass current evidence.
      expect(cargo[2]).toContain("FAILED");
      expect(cargo[2]).not.toContain(STILL_CURRENT);
      const evidence = session
        .getVerificationEvidenceLedgerSnapshot()
        .currentEvidence.filter((entry) => entry.command === "cargo test");
      expect(evidence.at(-1)?.status).toBe("failed");
      // The ledger keeps one record per run; the old pass may stay as history,
      // but only before the failure, never after it or in its place.
      expect(evidence.map((entry) => entry.status)).toEqual(["passed", "failed", "failed"]);
      expect(session.getVerificationProblem()).toMatch(/^Unverified: a check failed/);
      expect(await cargoRuns()).toHaveLength(3);
    } finally {
      await session.dispose();
    }
  }, 90_000);

  it("an untrusted project's plan never runs, even with MCP trust", async () => {
    const sentinel = path.join(shimDir, "plan-ran");
    await writeCargoShim();
    await write(
      "plan.mjs",
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({
            version: 1,
            mode: "changed",
            gates: [
              { id: "rust", argv: ["cargo", "test"], covers: ["crates/**"], quietBudgetSeconds: 5 },
            ],
          }),
        )});`,
        "",
      ].join("\n"),
    );
    await write(
      ".gg/verify-plan.json",
      JSON.stringify({
        version: 1,
        command: { argv: [process.execPath, "plan.mjs"] },
        format: "gg-verify-plan-v1",
      }),
    );
    // MCP trust for this project, but no approval of the descriptor's hash.
    await writeSettings({ trustProjectMcpServers: true, trustedProjects: [tmpProject] });
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const session = await newSession();
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(
      palsuToolCall("write", {
        file_path: path.join(tmpProject, "src", "a.ts"),
        content: "export const a = 2;\n",
      }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuText("Done."));

    try {
      await session.prompt("Run the Rust gate, set a to 2, run it again.");
      await expect(fs.access(sentinel)).rejects.toThrow();
      const cargo = resultsFor(session.getMessages(), "cargo test");
      expect(cargo).toHaveLength(2);
      // Without the plan's crates/** scope, the edit makes the whole-tree inputs new.
      expect(cargo[1]).not.toContain(STILL_CURRENT);
    } finally {
      await session.dispose();
    }
    await expect(fs.access(sentinel)).rejects.toThrow();
  }, 60_000);

  it("explicit user, project and command env settings win over the defaults", async () => {
    await writeCargoShim({ echoEnv: true });
    await write(".cargo/config.toml", '[env]\nRUST_TEST_THREADS = "3"\n');
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    setEnv("CARGO_BUILD_JOBS", "2");
    const session = await newSession();
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuToolCall("bash", { command: "RUST_TEST_THREADS=1 cargo test" }));
    palsu.appendResponses(palsuText("Done."));

    try {
      await session.prompt("Run the Rust gate.");
      const results = toolResults(session.getMessages()).map((result) => result.text);
      const plain = results.find((text) => text.includes("Command: cargo test"));
      const inline = results.find((text) => text.includes("Command: RUST_TEST_THREADS=1 cargo"));
      // User value passes through; project config is left to cargo, not overridden.
      expect(plain).toContain("env CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=unset");
      expect(plain).toContain("kept yours: CARGO_BUILD_JOBS=2");
      expect(plain).toMatch(/kept project config: RUST_TEST_THREADS \([^)]*config\.toml\)/);
      expect(inline).toContain("env CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=1");
      expect(inline).toContain("kept yours: CARGO_BUILD_JOBS=2");
    } finally {
      await session.dispose();
    }
  }, 60_000);

  it("the hard limit still stops a runaway command after it moved to the background", async () => {
    await writeSettings({ bashYieldSeconds: 1, bashHardLimitMinutes: 1 });
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const command = 'node -e "setInterval(() => {}, 1000)"';
    const session = await newSession();
    const script = runScript([
      once(palsuToolCall("bash", { command })),
      pollUntilExited(),
      once(palsuText("Done.")),
    ]);

    try {
      await session.prompt("Run the watcher.");
      expect(script.remaining()).toBe(0);
      const [task] = session.listBackgroundProcesses();
      expect(task?.stopReason).toBe("timedOut");
      expect(task?.completedAt ?? null).not.toBeNull();
      expect(lastResult(session.getMessages())).toContain(
        "stopped: hard time limit reached (timedOut)",
      );
      expect(() => process.kill(task?.pid ?? -1, 0)).toThrow();
    } finally {
      await session.dispose();
    }
  }, 150_000);
});
