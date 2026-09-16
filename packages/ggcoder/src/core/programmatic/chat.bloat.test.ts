import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// History-independent checks of the changed surfaces, not a repository-wide size gate.
describe("embedded chat touched-files bloat guard", () => {
  it("keeps assessment orchestration and browser contracts inside their existing owners", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [coordinator, assessment, chat, manifest, build] = await Promise.all([
      read("./assessment.ts"),
      read("../../../../gg-core/src/programmatic-assessment-contract.ts"),
      read("../../../../gg-core/src/programmatic-chat-contract.ts"),
      read("../../../../gg-core/package.json"),
      read("../../../../gg-core/tsup.config.ts"),
    ]);
    const imports = (source: string) => ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true).statements
      .filter(ts.isImportDeclaration).map((node) => (node.moduleSpecifier as ts.StringLiteral).text).sort();
    expect(imports(coordinator)).toEqual([
      "./advisory-tools.js", "./advisory.js", "@kenkaiiii/gg-agent", "@kenkaiiii/gg-core/programmatic-assessment-contract",
    ]);
    expect(imports(assessment)).toEqual(["./slash-command-contract.js"]);
    for (const source of [coordinator, assessment, chat]) {
      expect(source).not.toMatch(/\b(?:require|import)\s*\(/);
      expect(source).not.toMatch(/\b(?:fetch|setInterval|WebSocket|EventSource|eval)\s*\(/);
      expect(source).not.toMatch(/\b(?:writeFile|spawn|exec|createProvider|runAgentLoop|runProgrammaticScan|reconcileProgrammaticLifecycle|persistProgrammaticProfile)\s*\(/);
    }
    expect(coordinator).toContain("new ProgrammaticAdvisoryTools(");
    expect(coordinator).toContain("await runTurn(this.scope, this.context)");
    expect(coordinator).toContain("this.scope.close()");
    expect(coordinator).toContain("renderAdvisoryResult(accepted)");
    expect(chat).toContain('from "./programmatic-assessment-contract.js"');
    expect(chat).toContain("isProgrammaticAssessment(");
    expect(assessment).toContain("PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT = 4_000");
    expect(assessment).toContain("PROGRAMMATIC_ASSESSMENT_ITEM_LIMIT = 50");
    expect(assessment).not.toMatch(/\b(?:approvalHandle|proposalId|scannerDefinitions|recommendations)\s*:/);
    expect(JSON.parse(manifest).exports["./programmatic-assessment-contract"]).toEqual({
      types: "./dist/programmatic-assessment-contract.d.ts", import: "./dist/programmatic-assessment-contract.js",
      require: "./dist/programmatic-assessment-contract.cjs",
    });
    expect(build).toContain('"src/programmatic-assessment-contract.ts"');
  });
  it("reuses lifecycle, native transport and the existing event machine with bounded projections", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [adapter, lifecycle, contract, component, reducer, pane, events, client, native, assessmentComponent] = await Promise.all([
      read("../../app-sidecar-programmatic-chat.ts"), read("./lifecycle.ts"),
      read("../../../../gg-core/src/programmatic-chat-contract.ts"),
      read("../../../../../gg-app/src/ProgrammaticChat.tsx"),
      read("../../../../../gg-app/src/programmatic-chat-state.ts"),
      read("../../../../../gg-app/src/AgentPane.tsx"),
      read("../../../../../gg-app/src/useAgentEvents.ts"),
      read("../../../../../gg-app/src/agent.ts"),
      read("../../../../../gg-app/src-tauri/src/lib.rs"),
      read("../../../../../gg-app/src/ProgrammaticAssessment.tsx"),
    ]);
    expect(adapter).toContain("buildProgrammaticProfileProposal");
    expect(adapter).toContain("persistProgrammaticProfile");
    expect(adapter).not.toMatch(/\b(?:writeFile|rename|buildProgrammaticInventory|discoverProgrammaticOpportunities)\s*\(/);
    expect(lifecycle.match(/export async function dismissProgrammaticOpportunity\(/g)).toHaveLength(1);
    expect(lifecycle).toContain("opportunityTransitionV1Schema.parse");
    expect(contract).toContain("PROGRAMMATIC_CHAT_PAGE_LIMIT = 50");
    expect(contract).toContain("PROGRAMMATIC_CHAT_EVIDENCE_LIMIT = 50");
    expect(contract).not.toMatch(/from ["']node:|from ["'].*ggcoder/);
    expect(`${component}\n${reducer}`).not.toMatch(/\b(?:fetch|setInterval|WebSocket|EventSource)\s*\(|localStorage|sessionStorage/);
    expect(component).toContain('from "./Badge"');
    expect(component).not.toMatch(/from ["'](?!react|\.\/|@kenkaiiii\/gg-core)[^"']+["']/);
    expect(pane.match(/<ProgrammaticChat\b/g)).toHaveLength(1);
    expect(pane).toContain("client.sendPrompt(text)");
    expect(pane).toContain("programmaticOwner.current");
    expect(events).toContain("onProgrammaticActivity");
    expect(client).toContain('"agent_programmatic"');
    expect(native.match(/async fn agent_programmatic\(/g)).toHaveLength(1);
    expect(native).toContain("expected_generation");
    const presentation = `${component}\n${assessmentComponent}`;
    expect(`${presentation}\n${reducer}`).not.toMatch(/\b(?:fetch|setInterval|WebSocket|EventSource)\s*\(|localStorage|sessionStorage/);
    expect(presentation).not.toMatch(/from ["'](?!react|\.\/|@kenkaiiii\/gg-core)[^"']+["']/);
    expect(presentation).not.toMatch(/\b(?:require|import|eval)\s*\(|dangerouslySetInnerHTML/);
    expect(component.match(/<ProgrammaticAssessment\b/g)).toHaveLength(1);
    expect(Buffer.byteLength(assessmentComponent)).toBeLessThan(20_000);
    expect(Buffer.byteLength(component)).toBeLessThan(20_000);
    expect(Buffer.byteLength(reducer)).toBeLessThan(8_000);
    expect(Buffer.byteLength(adapter)).toBeLessThan(15_000);
  });
});
