import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// History-independent checks of the changed surfaces, not a repository-wide size gate.
describe("embedded chat touched-files bloat guard", () => {
  it("reuses lifecycle, native transport and the existing event machine with bounded projections", async () => {
    const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8");
    const [adapter, lifecycle, contract, component, reducer, pane, events, client, native] = await Promise.all([
      read("../../app-sidecar-programmatic-chat.ts"), read("./lifecycle.ts"),
      read("../../../../gg-core/src/programmatic-chat-contract.ts"),
      read("../../../../../gg-app/src/ProgrammaticChat.tsx"),
      read("../../../../../gg-app/src/programmatic-chat-state.ts"),
      read("../../../../../gg-app/src/AgentPane.tsx"),
      read("../../../../../gg-app/src/useAgentEvents.ts"),
      read("../../../../../gg-app/src/agent.ts"),
      read("../../../../../gg-app/src-tauri/src/lib.rs"),
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
    expect(Buffer.byteLength(component)).toBeLessThan(20_000);
    expect(Buffer.byteLength(reducer)).toBeLessThan(8_000);
    expect(Buffer.byteLength(adapter)).toBeLessThan(15_000);
  });
});
