import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFile(new URL(file, import.meta.url), "utf8");

describe("isolated execution touched-file architecture", () => {
  it("reuses one transient session and its loop, tools, context and disposal", async () => {
    const execution = await source("./execution.ts");
    expect(execution.match(/new AgentSession\(/g)).toHaveLength(1);
    expect(execution).toContain("transient: true");
    expect(execution).toContain('agentContext: "project"');
    expect(execution).toContain("session!.promptResolvedCommand(");
    expect(execution).toContain("session.dispose()");
    expect(execution).toContain("session.setToolCapabilityPolicy(");
    expect(execution).not.toMatch(/agentLoop\(|new ToolRegistry|spawn\(|runAgentLoop|resumePath|new SessionManager|setInterval\(/);
    expect(execution).not.toMatch(/node:fs|node:child_process|writeFile\(|rename\(|withFileLock\(/);
  });

  it("bounds evidence and listeners instead of buffering transcripts or scheduling reruns", async () => {
    const execution = await source("./execution.ts");
    expect(execution).toContain("calls.size < 64");
    expect(execution).toContain("observed.size < 32");
    expect(execution).toContain("maxTurns: 30, maxTurnExtensions: 0");
    expect(execution).toContain("clearTimeout(timer)");
    expect(execution).toContain("listeners.forEach((remove) => remove())");
    expect(execution).toContain("if (cleanupOk) projectClaims.delete(root)");
    expect(execution).toContain("AbortSignal.timeout(CLEANUP_DEADLINE_MS)");
    expect(execution).not.toMatch(/transcript\s*\+=|messages\.push|setInterval|\.retry\(|\.enqueue\(/);
  });

  it("shares command expansion", async () => {
    const session = await source("../agent-session.ts");
    expect(session.match(/## User Instructions\\n\\n/g)).toHaveLength(1);

  });
});
