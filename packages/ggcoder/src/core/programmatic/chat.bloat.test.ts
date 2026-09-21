import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// History-independent checks of the changed surfaces, not a repository-wide size gate.
describe("embedded chat touched-files bloat guard", () => {
  it("keeps discovery display browser-safe and review free of persistence or execution owners", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [shared, projection, review] = await Promise.all([
      read("../../../../gg-core/src/programmatic-discovery-contract.ts"), read("./discovery-projection.ts"), read("./discovery-review.ts"),
    ]);
    expect(shared).not.toMatch(/from ["']node:|from ["'].*ggcoder|\bzod\b/);
    for (const source of [shared, projection, review]) {
      expect(Buffer.byteLength(source)).toBeLessThan(7_000);
      expect(source).not.toMatch(/\b(?:fetch|setInterval|writeFile|rename|spawn|exec|createProvider|runAgentLoop|runProgrammaticScan|updateRecommendationHistory)\s*\(/);
    }
    expect(shared).toContain("candidates: list(isDiscoveryCandidate, 10)");
    expect(review).toContain("++this.calls > 64");
  });
  it("keeps history bounded and independent of scanner and execution ownership", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [domain, pure, history, storage, shared, tools] = await Promise.all([
      read("./recommendation-contracts.ts"), read("./recommendations.ts"), read("./recommendation-history.ts"), read("./storage.ts"),
      read("../../../../gg-core/src/programmatic-recommendation-contract.ts"), read("./advisory-tools.ts"),
    ]);
    for (const source of [domain, pure, history, storage]) {
      expect(Buffer.byteLength(source)).toBeLessThan(20_000);
      expect(source).not.toMatch(/\b(?:fetch|setInterval|spawn|exec|createProvider|runAgentLoop|reconcileProgrammaticLifecycle)\s*\(/);
    }
    expect(pure).not.toMatch(/from ["']node:fs|from ["'].\/(?:profile|recommendation-history|lifecycle)\.js/);
    expect(shared).not.toMatch(/from ["']node:|from ["'].*ggcoder|\bzod\b/);
    expect(Buffer.byteLength(shared)).toBeLessThan(10_000);
    expect(domain).toContain("candidates: 1_000, assessments: 4_096, events: 16_384, bytes: 16 * 1024 * 1024");
    expect(history).toContain("withFileLock(containedPath(root, PROGRAMMATIC_PROFILE_PATH)");
    expect(history).toContain("withFileLock(containedPath(root, RECOMMENDATION_HISTORY_PATH)");
    expect(tools).not.toMatch(/updateRecommendationHistory|decideRecommendation|confirmRecommendationCorrespondence/);
  });
  it("shares narrow host history persistence without adding a second terminal store", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [host, terminal, session] = await Promise.all([
      read("./assessment-history.ts"), read("../../ui/hooks/useAgentLoop.ts"), read("../agent-session.ts"),
    ]);
    expect(Buffer.byteLength(host)).toBeLessThan(5_000);
    expect(host).not.toMatch(/\b(?:writeFile|rename|withFileLock|fetch|setInterval|spawn|exec|runAgentLoop|runProgrammaticScan)\s*\(/);
    expect(host.match(/await updateRecommendationHistory\(/g)).toHaveLength(1);
    for (const source of [terminal, session]) {
      expect(source).toContain("await captureAssessmentHistoryPolicy(");
      expect(source).toContain("await saveAssessmentHistory(");
      expect(source).not.toContain("updateRecommendationHistory(");
    }
  });
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
      "../tauri-package/paths.js", "./advisory-tools.js", "./advisory.js", "./discovery-projection.js", "./recommendations.js",
      "@kenkaiiii/gg-agent", "@kenkaiiii/gg-core/programmatic-assessment-contract", "node:crypto",
    ]);
    expect(imports(assessment)).toEqual(["./programmatic-recommendation-contract.js", "./slash-command-contract.js"]);
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
    const setupProjection = await read("../../app-sidecar-programmatic-projection.ts");
    expect(adapter).toContain("projectProgrammaticSetup(proposal, handle)");
    expect(Buffer.byteLength(setupProjection)).toBeLessThan(2_000);
    expect(setupProjection).not.toMatch(/from ["']node:|\b(?:fetch|writeFile|rename|spawn|exec|persistProgrammaticProfile)\s*\(/);
    expect(setupProjection).toContain("proposal.routes.map");
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
