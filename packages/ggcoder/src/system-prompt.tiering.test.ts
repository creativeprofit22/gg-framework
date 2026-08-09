import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools/index.js";
import { CORE_TOOL_NAMES, DEFERRED_TOOL_NAMES, partitionToolsByTier } from "./tools/tool-tiers.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-tiering-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Exactly what a provider transform serializes for one tool definition. */
function serializeTool(tool: { name: string; description: string; parameters: unknown }): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.parameters as z.ZodType),
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("tool tiering in the system prompt", () => {
  it("indexes every deferred tool exactly once", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "edit", "bash", "grep", "tool_search"],
      undefined,
      "anthropic",
      undefined,
      DEFERRED_TOOL_NAMES,
    );

    for (const name of DEFERRED_TOOL_NAMES) {
      expect(countOccurrences(prompt, `- **${name}**:`), `index line for ${name}`).toBe(1);
    }
    expect(prompt).toContain("Available on demand (call `tool_search` to load):");
  });

  it("never double-lists a tool that is already live", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "source_path", "tool_search"],
      undefined,
      "anthropic",
      undefined,
      ["source_path", "screenshot"],
    );

    expect(countOccurrences(prompt, "- **source_path**:")).toBe(1);
    expect(countOccurrences(prompt, "- **screenshot**:")).toBe(1);
  });

  it("keeps deferred parameter schemas out of the serialized tool payload", async () => {
    const cwd = await makeProject();
    const { tools, processManager, lspManager } = await createTools(cwd, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      lspDiagnostics: false,
    });
    const { core, deferred } = partitionToolsByTier(tools);
    expect(deferred.length).toBeGreaterThan(0);

    const payload = core.map(serializeTool).join("\n");
    for (const tool of deferred) {
      expect(payload).not.toContain(`"name":"${tool.name}"`);
      // A deferred tool's own schema body must not leak in through another tool.
      expect(payload).not.toContain(serializeTool(tool));
    }

    processManager.shutdownAll();
    await lspManager?.shutdownAll?.();
  });

  it("produces a stable, append-only core tool order across builds", async () => {
    const cwd = await makeProject();
    const build = async (): Promise<string[]> => {
      const { tools, processManager, lspManager } = await createTools(cwd, {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        lspDiagnostics: false,
      });
      const { core } = partitionToolsByTier(tools);
      processManager.shutdownAll();
      await lspManager?.shutdownAll?.();
      return core.map((t) => t.name);
    };

    const first = await build();
    const second = await build();
    // Reordering the tool array invalidates the whole cached prefix, so the
    // order is a contract, not an implementation detail.
    expect(second).toEqual(first);
    for (const name of first) expect(CORE_TOOL_NAMES).toContain(name);
  });

  it("holds the tiered prompt inside its character budget", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      CORE_TOOL_NAMES,
      undefined,
      "anthropic",
      undefined,
      DEFERRED_TOOL_NAMES,
    );
    // The whole point of tiering is that the index is cheap: the on-demand
    // block must stay a rounding error next to a schema per tool.
    const indexBlockStart = prompt.indexOf("Available on demand");
    const indexBlock = prompt.slice(indexBlockStart, prompt.indexOf("\n\n", indexBlockStart));
    expect(indexBlock.length).toBeLessThan(1_200);
    expect(prompt.length).toBeLessThan(8_000);
  });
});
