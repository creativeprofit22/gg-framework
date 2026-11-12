import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// History-independent checks of the per-area search surfaces, not a repository-wide size gate.
describe("per-area search touched-files bloat guard", () => {
  const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");

  it("reuses one transient AgentSession per area instead of a second runner or store", async () => {
    const [pass, search] = await Promise.all([read("./area-pass.ts"), read("./area-search.ts")]);
    expect(pass.match(/new AgentSession\(/g)).toHaveLength(1);
    expect(pass).toContain("transient: true");
    expect(pass).toContain("subagentWorker: true");
    expect(pass).toContain('import { bounded } from "./execution.js"');
    expect(pass).toContain("validateAdvisoryEvidenceItems(");
    for (const source of [pass, search]) {
      expect(source).not.toMatch(
        /\b(?:agentLoop|runAgentLoop|ToolRegistry|spawn|execFile|exec|fetch|writeFile|appendFile|rename|mkdir|rm|unlink)\s*\(/,
      );
      expect(source).not.toMatch(/from ["']node:(?:fs|child_process)/);
      expect(source).not.toMatch(
        /approval(?:Store|Cache)|new Map<string, boolean>\(\)\s*;?\s*\/\/\s*approv/i,
      );
    }
    // Pure selection, scheduling and merge: no session or I/O imports.
    expect(search).not.toMatch(/from ["']\.\.\/agent-session\.js["']|from ["']node:/);
    expect(Buffer.byteLength(search)).toBeLessThan(16_000);
    expect(Buffer.byteLength(pass)).toBeLessThan(20_000);
  });

  it("wires both paths through the existing result tool and adds no package dependency", async () => {
    const [wiring, manifest] = await Promise.all([
      read("../agent-session-programmatic.ts"),
      read("../../../package.json"),
    ]);
    expect(wiring.match(/createProgrammaticAdvisoryResultTool\(/g)).toHaveLength(1);
    expect(wiring.match(/new ProgrammaticAssessmentCoordinator\(/g)).toHaveLength(1);
    expect(wiring).toContain("runAreaPasses(");
    const deps = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;
    const names = [
      ...Object.keys(deps.dependencies ?? {}),
      ...Object.keys(deps.devDependencies ?? {}),
    ];
    expect(names.filter((name) => /area|p-limit|p-queue|async-pool/i.test(name))).toEqual([]);
  });
});
