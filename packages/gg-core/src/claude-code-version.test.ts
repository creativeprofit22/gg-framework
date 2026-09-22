import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-ccv-"));
  prevAgentDir = process.env.GG_AGENT_DIR;
  process.env.GG_AGENT_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.GG_AGENT_DIR;
  else process.env.GG_AGENT_DIR = prevAgentDir;
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function load() {
  return await import("./claude-code-version.js");
}

function cacheFile(): string {
  return path.join(tmpDir, "claude-code-version.json");
}

describe("parseRequiredClaudeCodeVersion", () => {
  it("extracts the minimum version from Anthropic's model-gate error", async () => {
    const { parseRequiredClaudeCodeVersion } = await load();
    expect(
      parseRequiredClaudeCodeVersion(
        "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.",
      ),
    ).toBe("2.1.280");
  });

  it("returns null for unrelated errors", async () => {
    const { parseRequiredClaudeCodeVersion } = await load();
    expect(parseRequiredClaudeCodeVersion("overloaded_error: server busy")).toBeNull();
  });
});

describe("noteRequiredClaudeCodeVersion", () => {
  it("raises the cached version past a stale cache and reports a retry", async () => {
    await fs.writeFile(
      cacheFile(),
      JSON.stringify({ version: "2.1.278", fetchedAt: Date.now() }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "2.1.280" }), { status: 200 })),
    );

    const { noteRequiredClaudeCodeVersion, getClaudeCliUserAgent } = await load();
    expect(
      await noteRequiredClaudeCodeVersion(
        "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required.",
      ),
    ).toBe(true);
    expect(await getClaudeCliUserAgent()).toBe("claude-cli/2.1.280 (external, cli)");
  });

  it("falls back to the demanded version when npm is unreachable", async () => {
    await fs.writeFile(
      cacheFile(),
      JSON.stringify({ version: "2.1.278", fetchedAt: Date.now() }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const { noteRequiredClaudeCodeVersion, getClaudeCodeVersion } = await load();
    expect(
      await noteRequiredClaudeCodeVersion("version 2.1.280 or newer is required."),
    ).toBe(true);
    expect(await getClaudeCodeVersion()).toBe("2.1.280");
  });

  it("does not retry when the cached version already satisfies the requirement", async () => {
    await fs.writeFile(
      cacheFile(),
      JSON.stringify({ version: "2.1.281", fetchedAt: Date.now() }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "2.1.281" }), { status: 200 })),
    );

    const { noteRequiredClaudeCodeVersion } = await load();
    expect(
      await noteRequiredClaudeCodeVersion("version 2.1.280 or newer is required."),
    ).toBe(false);
  });

  it("ignores errors that carry no version requirement", async () => {
    const { noteRequiredClaudeCodeVersion } = await load();
    expect(await noteRequiredClaudeCodeVersion("rate_limit_error")).toBe(false);
  });
});
