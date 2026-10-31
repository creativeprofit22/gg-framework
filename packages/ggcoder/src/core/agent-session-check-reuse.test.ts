// Real AgentSession + agent loop against a scripted palsu provider: a supa-shaped
// flow (edit TS, run the Rust gate once, git status, finish) must end verified
// without a harness re-run of the check.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerPalsuProvider,
  palsuText,
  palsuToolCall,
  type PalsuProviderHandle,
} from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import { verifyPlanApproval } from "./verify-plan-approval.js";

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let shimDir: string;
let cargoLog: string;
let originalPath: string | undefined;
let palsu: PalsuProviderHandle;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-check-reuse-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-check-reuse-project-"));
  shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-check-reuse-bin-"));
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
  await fs.mkdir(path.join(tmpProject, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpProject, "src", "a.ts"), "export const a = 1;\n", "utf-8");

  // Fake cargo that records each run, so the test can count executions.
  const logPosix = cargoLog.replace(/\\/g, "/");
  await fs.writeFile(
    path.join(shimDir, "cargo"),
    `#!/bin/sh\necho "cargo $*" >> "${logPosix}"\necho "test result: ok. 3 passed; 0 failed"\n`,
    { encoding: "utf-8", mode: 0o755 },
  );
  await fs.writeFile(
    path.join(shimDir, "cargo.cmd"),
    `@echo off\r\necho cargo %*>> "${cargoLog}"\r\necho test result: ok. 3 passed; 0 failed\r\n`,
    "utf-8",
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
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

describe("a passing check stays current through read-only commands", () => {
  it("edit TS, run the Rust gate once, git status, finish: verified without a re-run", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5-5", // real id so registry lookups succeed; palsu ignores it
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    palsu.appendResponses(
      palsuToolCall("write", {
        file_path: path.join(tmpProject, "src", "a.ts"),
        content: "export const a = 2;\n",
      }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuToolCall("bash", { command: "git status --short" }));
    palsu.appendResponses(palsuText("Done: a is 2 and cargo test passes."));

    try {
      await session.prompt("Set a to 2 and run the Rust gate.");

      expect(await fs.readFile(path.join(tmpProject, "src", "a.ts"), "utf-8")).toBe(
        "export const a = 2;\n",
      );
      expect(session.getVerificationProblem()).toBeNull();
      const snapshot = session.getVerificationEvidenceLedgerSnapshot();
      expect(
        snapshot.currentEvidence.filter(
          (entry) => entry.command === "cargo test" && entry.status === "passed",
        ),
      ).toHaveLength(1);
      expect(snapshot.currentEvidence.some((entry) => entry.command === "git status --short")).toBe(
        false,
      );
      expect(await cargoRuns()).toEqual(["cargo test"]);
      expect(palsu.getPendingResponseCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  }, 60_000);
});

const PRIOR_PASS = "Same check passed with identical inputs";

function cargoResults(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ content?: unknown }>) {
      const text = JSON.stringify(part.content ?? "");
      if (text.includes("Command: cargo test")) texts.push(text);
    }
  }
  return texts;
}

function handedOffTaskId(messages: unknown[]): string {
  const text = JSON.stringify(messages);
  const parts = text.split("moved to background task ");
  return parts[parts.length - 1]?.split(" ")[0] ?? "";
}

describe("identical check re-runs", () => {
  beforeEach(() => {
    execFileSync("git", ["init", "-q"], { cwd: tmpProject });
  });

  it("names the identical earlier pass and still runs; an edit makes the whole-tree inputs new", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5-5",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    const file = path.join(tmpProject, "src", "a.ts");
    palsu.appendResponses(
      palsuToolCall("write", { file_path: file, content: "export const a = 2;\n" }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(
      palsuToolCall("write", { file_path: file, content: "export const a = 3;\n" }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuText("Done."));

    try {
      await session.prompt("Set a and run the Rust gate.");
      const results = cargoResults(session.getMessages());
      expect(results).toHaveLength(3);
      expect(results[0]).not.toContain(PRIOR_PASS);
      expect(results[1]).toContain(PRIOR_PASS);
      expect(results[1]).toContain("it is still current evidence, so this re-run is optional.");
      // No verify plan is loaded, so any edit changes the whole-tree inputs.
      expect(results[2]).not.toContain(PRIOR_PASS);
      expect(await cargoRuns()).toHaveLength(3);
      expect(session.getVerificationProblem()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 60_000);

  it("settles a handed-off check's fingerprint when task_output reports it finished", async () => {
    await fs.writeFile(
      path.join(tmpHome, ".gg", "settings.json"),
      JSON.stringify({ bashYieldSeconds: 1 }),
      "utf-8",
    );
    // Outlast the yield; Windows never yields before 10 seconds.
    const seconds = process.platform === "win32" ? 12 : 3;
    const logPosix = cargoLog.replace(/\\/g, "/");
    await fs.writeFile(
      path.join(shimDir, "cargo"),
      `#!/bin/sh\nsleep ${seconds}\necho "cargo $*" >> "${logPosix}"\necho "test result: ok. 3 passed; 0 failed"\n`,
      { encoding: "utf-8", mode: 0o755 },
    );
    await fs.writeFile(
      path.join(shimDir, "cargo.cmd"),
      `@echo off\r\nping -n ${seconds + 1} 127.0.0.1 >nul\r\necho cargo %*>> "${cargoLog}"\r\necho test result: ok. 3 passed; 0 failed\r\n`,
      "utf-8",
    );
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5-5",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    const waitForTask = (messages: Parameters<typeof handedOffTaskId>[0]) =>
      palsuToolCall("task_output", { id: handedOffTaskId(messages), wait_ms: 30_000 });
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses((messages) => waitForTask(messages));
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses((messages) => waitForTask(messages));
    palsu.appendResponses(palsuText("Done."));

    try {
      await session.prompt("Run the Rust gate.");
      const results = cargoResults(session.getMessages());
      expect(results).toHaveLength(2);
      expect(results[0]).toContain("moved to background task");
      expect(results[0]).not.toContain(PRIOR_PASS);
      // The notice also reaches the agent at the hand-off point of the re-run.
      expect(results[1]).toContain("moved to background task");
      expect(results[1]).toContain(PRIOR_PASS);
      expect(await cargoRuns()).toHaveLength(2);
      const passes = session
        .getVerificationEvidenceLedgerSnapshot()
        .currentEvidence.filter((entry) => entry.command === "cargo test");
      expect(passes.map((entry) => entry.status)).toEqual(["passed", "passed"]);
    } finally {
      await session.dispose();
    }
  }, 90_000);
});

describe("project verify plan", () => {
  beforeEach(async () => {
    execFileSync("git", ["init", "-q"], { cwd: tmpProject });
    const plan = {
      version: 1,
      mode: "changed",
      gates: [{ id: "rust", argv: ["cargo", "test"], covers: ["crates/**"] }],
    };
    await fs.writeFile(
      path.join(tmpProject, "plan.mjs"),
      `process.stdout.write(${JSON.stringify(JSON.stringify(plan))});\n`,
      "utf-8",
    );
    await fs.mkdir(path.join(tmpProject, ".gg"), { recursive: true });
    const descriptor = JSON.stringify({
      version: 1,
      command: { argv: [process.execPath, "plan.mjs"] },
      format: "gg-verify-plan-v1",
    });
    await fs.writeFile(path.join(tmpProject, ".gg", "verify-plan.json"), descriptor, "utf-8");
    // Approval of this exact descriptor; MCP trust alone would not run it.
    await fs.writeFile(
      path.join(tmpHome, ".gg", "settings.json"),
      JSON.stringify({
        verifyPlanApprovals: [verifyPlanApproval(tmpProject, descriptor)],
      }),
      "utf-8",
    );
  });

  it("keeps a gate pass current across an edit outside its covers", async () => {
    // tmpProject may be an alias (macOS /var, Windows 8.3) of the canonical git root.
    const project = path.resolve(tmpProject);
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5-5",
      cwd: project,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(
      palsuToolCall("write", {
        file_path: path.join(project, "src", "a.ts"),
        content: "export const a = 2;\n",
      }),
    );
    palsu.appendResponses(palsuToolCall("bash", { command: "cargo test" }));
    palsu.appendResponses(palsuText("Done."));

    try {
      await session.prompt("Run the Rust gate, set a to 2, run it again.");
      const results = cargoResults(session.getMessages());
      expect(results).toHaveLength(2);
      // Whole-tree inputs would have changed; the plan scopes the gate to crates/**.
      expect(results[1]).toContain(PRIOR_PASS);
      expect(results[1]).toContain("it is still current evidence, so this re-run is optional.");
      expect(await cargoRuns()).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
