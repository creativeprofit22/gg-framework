import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type * as CommandDiscovery from "../../core/command-discovery.js";
import { prepareTerminalProgrammaticAssessment } from "./terminal-programmatic-assessment.js";

vi.mock("../../core/command-discovery.js", async (original) => ({
  ...(await original<typeof CommandDiscovery>()),
  // Configured mode needs an approved setup; readiness is not under test here.
  createProgrammaticReadinessReader: () => async () => "current" as const,
}));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const FAMILY_ID = "0123456789abcdef";
const MEMBERS = ["config/regions/ap-south", "config/regions/eu-west", "config/regions/us-east"];
const inspectFacts = {
  ok: true,
  item_families: {
    families: [{ id: FAMILY_ID, members: MEMBERS.map((member) => ({ path: member })) }],
  },
};

function fakeTool(name: string, output: unknown): AgentTool {
  return {
    name,
    description: `fake ${name}`,
    parameters: z.object({}).passthrough(),
    execute: async () => JSON.stringify(output),
  };
}

async function hostFamilies(mode: "setup" | "configured") {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-terminal-families-"));
  dirs.push(cwd);
  // Configured mode must not record families even if a tool returned some.
  const tools = [
    fakeTool("programmatic_profile", inspectFacts),
    fakeTool("programmatic_scan", inspectFacts),
  ];
  const prepared = await prepareTerminalProgrammaticAssessment(
    { cwd, mode },
    () => tools,
    new AbortController().signal,
  );
  await prepared.hostPrompt("base");
  const families: unknown = Reflect.get(prepared.coordinator.scope.turn, "families");
  if (!(families instanceof Map)) throw new Error("Turn families are not a Map.");
  return families;
}

it("records item families from the host setup inspection for generator recommendations", async () => {
  const families = await hostFamilies("setup");
  expect([...families.keys()]).toEqual([FAMILY_ID]);
  expect(families.get(FAMILY_ID)).toEqual(new Set(MEMBERS));
});

it("records no item families in configured mode", async () => {
  const families = await hostFamilies("configured");
  expect(families.size).toBe(0);
});
