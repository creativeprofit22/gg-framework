/**
 * Tool-catalog pin: the schemas this repo ships are the schemas we think we ship.
 *
 * Builds the REAL default tool array via `createTools()` — the same factory every
 * session entry point (agent-session, CLI, interactive) uses — serializes each
 * tool with `resolveToolSchema` (the exact encoding provider requests carry),
 * and pins the canonicalized catalog against a committed snapshot.
 *
 * Why: an accidental schema/description edit is silent. It changes what every
 * model sees on every request, and invalidates the cached prompt prefix, without
 * failing any test that isn't explicitly looking. This test is the test that is
 * explicitly looking (deepseek-harness takeaway: CI-verified tool catalog).
 *
 * Regenerate after an INTENTIONAL schema change:
 *   UPDATE_TOOL_CATALOG=1 pnpm vitest run tools/tool-catalog.test.ts
 * and review the snapshot diff like any code diff.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToolSchema } from "@kenkaiiii/gg-ai";
import { createTools } from "./index.js";
import { BUILTIN_TOOL_NAMES } from "./prompt-hints.js";

const SNAPSHOT_PATH = path.join(import.meta.dirname, "tool-catalog.snapshot.json");

/**
 * Tools a bare `createTools()` call cannot register: each needs a session-level
 * option (agent-session supplies it) rather than being a factory default. A name
 * moving between this set and the built catalog is itself a reviewable diff —
 * it changes the default model-visible surface.
 */
const OPT_IN_TOOLS = new Set([
  "tool_search", // registered by AgentSession.ensureToolSearchTool()
  "web_search", // provider-gated: non-anthropic providers only
  "subagent", // needs agents[] + provider + model
  "spawn_agent", // subagent control tools (same gate)
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
  "skill", // needs configured skills
  "enter_plan", // needs onEnterPlan callback
  "exit_plan", // needs onExitPlan callback
  "generate_image", // gated on OpenAI auth
]);

/** Deterministic JSON: object keys sorted at every depth, stable stringification. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

async function buildCatalog(): Promise<
  Array<{ name: string; description: string; schema: unknown; hash: string }>
> {
  // Fixed temp cwd so no tool state leaks between runs; descriptions do not
  // embed cwd (verified — factories use static description text).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-tool-catalog-"));
  try {
    const { tools } = await createTools(cwd);
    return tools.map((tool) => {
      const entry = {
        name: tool.name,
        description: tool.description,
        schema: resolveToolSchema(tool as never),
      };
      return { ...entry, hash: createHash("sha256").update(canonical(entry)).digest("hex") };
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("tool catalog snapshot", () => {
  it("pins the default tool catalog (schemas the model actually receives)", async () => {
    const catalog = await buildCatalog();

    // Duplicate names would mean a registry bug, not a schema change.
    const names = catalog.map((t) => t.name);
    expect(new Set(names).size, `duplicate tool names: ${names.join(", ")}`).toBe(names.length);

    const snapshot = {
      version: 1,
      // Sorted for a stable, reviewable diff (order in the array is append-only
      // and guarded separately by system-prompt.tiering.test.ts).
      tools: [...catalog].sort((a, b) => (a.name < b.name ? -1 : 1)),
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    if (process.env.UPDATE_TOOL_CATALOG === "1") {
      fs.writeFileSync(SNAPSHOT_PATH, serialized);
      console.log(`[tool-catalog] wrote ${catalog.length} tools to ${SNAPSHOT_PATH}`);
      return;
    }

    expect(fs.existsSync(SNAPSHOT_PATH), "snapshot missing — run with UPDATE_TOOL_CATALOG=1").toBe(
      true,
    );
    const pinned = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    // Compare per-tool hashes first: on mismatch the diff shows exactly WHICH
    // tool changed, not a wall of JSON.
    const pinnedNames = JSON.parse(pinned).tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(pinnedNames);
    if (serialized !== pinned) {
      const changed = snapshot.tools
        .filter((t) => {
          const pinnedTool = JSON.parse(pinned).tools.find(
            (p: { name: string }) => p.name === t.name,
          );
          return !pinnedTool || pinnedTool.hash !== t.hash;
        })
        .map((t) => t.name);
      const subject = changed.length > 0 ? changed.join(", ") : "snapshot formatting/extra keys";
      throw new Error(
        `Tool catalog drifted: ${subject}. If intentional, regenerate with ` +
          `UPDATE_TOOL_CATALOG=1 pnpm vitest run tools/tool-catalog.test.ts and review the diff. ` +
          `Schema changes alter every request and invalidate cached prefixes — they deserve eyes.`,
      );
    }
  });

  it("keeps the default surface complete: every built-in is either live or documented opt-in", async () => {
    const catalog = await buildCatalog();
    const live = new Set(catalog.map((t) => t.name));
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(
        live.has(name) || OPT_IN_TOOLS.has(name),
        `${name} is neither in the default catalog nor the OPT_IN_TOOLS set — ` +
          `the completeness guard can no longer account for it`,
      ).toBe(true);
    }
    // And the inverse: nothing rides along that the registry doesn't know.
    const known = new Set([...BUILTIN_TOOL_NAMES, ...OPT_IN_TOOLS]);
    for (const name of live) {
      expect(known.has(name), `unregistered tool ${name} reached the default catalog`).toBe(true);
    }
  });
});
