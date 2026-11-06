import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoadmapGit,
  RoadmapGitError,
  type RoadmapGitExec,
  type RoadmapGitExecOptions,
} from "./roadmap-git.js";

function recordingExec(result: (options: RoadmapGitExecOptions) => Promise<Buffer>) {
  const calls: { args: string[]; options: RoadmapGitExecOptions }[] = [];
  const exec: RoadmapGitExec = (_file, args, options) => {
    calls.push({ args, options });
    return result(options);
  };
  return { exec, calls };
}

function rejection(fields: Record<string, unknown>): Promise<Buffer> {
  return Promise.reject(Object.assign(new Error("Command failed"), fields));
}

describe("roadmap git runner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports a killed process as a timeout", async () => {
    const { exec } = recordingExec(() =>
      rejection({ killed: true, code: null, signal: "SIGTERM" }),
    );
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => 1_000 });

    const error = await git(["status", "--porcelain=v1"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RoadmapGitError);
    expect(error).toMatchObject({ kind: "timeout", subcommand: "status", exitCode: null });
  });

  it("captures the exit code and first stderr line of a failed command", async () => {
    const { exec } = recordingExec(() =>
      rejection({
        code: 128,
        stderr: Buffer.from(
          "\nfatal: not a git repository (or any of the parent directories): .git\nmore\n",
        ),
      }),
    );
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => 1_000 });

    await expect(git(["rev-parse", "--show-toplevel"])).rejects.toMatchObject({
      kind: "exit",
      subcommand: "rev-parse",
      exitCode: 128,
      stderrLine: "fatal: not a git repository (or any of the parent directories): .git",
    });
  });

  it("reports a missing binary as a spawn failure", async () => {
    const { exec } = recordingExec(() => rejection({ code: "ENOENT" }));
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => 1_000 });

    await expect(git(["status"])).rejects.toMatchObject({ kind: "spawn", stderrLine: "ENOENT" });
  });

  it("runs without optional locks, prompts, pagers, or the Qwen credential", async () => {
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "secret-value");
    const { exec, calls } = recordingExec(() => Promise.resolve(Buffer.from("ok")));
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => 1_000 });

    await expect(git(["status"])).resolves.toEqual(Buffer.from("ok"));

    const options = calls[0]?.options;
    expect(options?.cwd).toBe("/repo");
    expect(options?.windowsHide).toBe(true);
    expect(options?.env).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    });
    expect(options?.env).not.toHaveProperty("QWEN_CLOUD_TOKEN_PLAN_KEY");
  });

  it("shrinks each call's timeout to the shared deadline", async () => {
    let clock = 1_000;
    const { exec, calls } = recordingExec(() => {
      clock += 4_000;
      return Promise.resolve(Buffer.alloc(0));
    });
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => clock });

    await git(["rev-parse", "HEAD"]);
    await git(["status"]);

    expect(calls.map((call) => call.options.timeout)).toEqual([9_000, 5_000]);
  });

  it("fails as a timeout without spawning once the deadline has passed", async () => {
    const { exec, calls } = recordingExec(() => Promise.resolve(Buffer.alloc(0)));
    const git = createRoadmapGit("/repo", { exec, deadlineMs: 10_000, now: () => 10_000 });

    await expect(git(["ls-files"])).rejects.toMatchObject({
      kind: "timeout",
      subcommand: "ls-files",
    });
    expect(calls).toHaveLength(0);
  });
});
