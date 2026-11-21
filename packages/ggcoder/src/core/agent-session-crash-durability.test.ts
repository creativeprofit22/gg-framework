import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "crash-mid-tool-batch.mjs",
);

let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

interface CrashRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run the fixture to its self-inflicted SIGKILL and return how it died. */
function runFixture(): Promise<CrashRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, tmpProject], {
      // Run from the package root so `tsx` resolves; the session's working
      // directory is passed explicitly as an argument.
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        // Keep the fixture off the user's real config and away from the network.
        GG_DISABLE_TELEMETRY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Every `message` entry in a session file, in file order. */
async function readMessages(sessionPath: string): Promise<{ role: string; text: string }[]> {
  const raw = await fs.readFile(sessionPath, "utf-8");
  const messages: { role: string; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { role: string; content: unknown };
    };
    if (entry.type !== "message" || !entry.message) continue;
    messages.push({ role: entry.message.role, text: JSON.stringify(entry.message.content) });
  }
  return messages;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-crash-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-crash-project-"));
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("session durability across a mid-run crash", () => {
  it("replays every message up to the last completed step", async () => {
    const run = await runFixture();

    // The process must have been killed, not exited cleanly — otherwise the
    // post-loop flush ran and this proves nothing. Windows reports forced
    // termination as a non-zero exit code rather than a POSIX signal.
    expect(run.stdout, run.stderr).toContain("CRASHING");
    expect(run.stdout).not.toContain("NO_CRASH");
    if (process.platform === "win32") {
      expect(run.signal).toBeNull();
      expect(run.code).not.toBe(0);
    } else {
      expect(run.signal).toBe("SIGKILL");
    }

    const sessionPath = /^SESSION (.+)$/m.exec(run.stdout)?.[1];
    expect(sessionPath, run.stdout).toBeTruthy();

    const persisted = await readMessages(sessionPath!);
    const roles = persisted.map((m) => m.role);

    // user prompt → step 1 assistant → step 1 tool results → step 2 assistant.
    // Before step-boundary flushing, ONLY the user message survived a crash.
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(persisted[1]!.text).toContain("working on step 1");
    expect(persisted[2]!.text).toContain("output 1");
    expect(persisted[3]!.text).toContain("working on step 2");

    // The in-flight step's tool results never reached a checkpoint, so they are
    // legitimately absent — a crash loses at most the step it was running.
    expect(persisted.some((m) => m.text.includes("output 2"))).toBe(false);
  }, 120_000);
});
