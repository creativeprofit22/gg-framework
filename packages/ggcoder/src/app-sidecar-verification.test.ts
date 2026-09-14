import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Run settlement lives inside the daemon closure, with no injectable session seam.
// Pin its routing here; session verification and UI settlement have runtime suites.
describe("desktop verification settlement", () => {
  it("settles actual run outcomes independently of transcript certification and Roadmap Done", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("let outcome: RunOutcome = cancelled");
    const end = source.indexOf("// Autopilot's review loop", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const settlement = source.slice(start, end);
    expect(settlement).not.toContain("broadcastError(");
    expect(settlement).not.toContain("verificationProblem");
    expect(settlement).not.toContain("getVerificationProblem");
    expect(settlement).toContain('programmaticSettlement?.journalOutcome ?? (!runSucceeded ? "failed" : "completed")');
    expect(settlement).toContain('if (cancelled) outcome = "aborted"');
    expect(settlement).toContain("...createRunEndPayload(outcome, runLifecycle.state)");
    expect(settlement).toContain("runLifecycle.recordOutcome(generation, outcome)");
    expect(settlement).toContain("finishOwnedGeneration(generation, false, outcome)");
    expect(settlement).toContain("await runJournalPersistence");
    expect(settlement).not.toContain("notesRepository.recordImplementationCheckpoint");
    expect(source).toContain('broadcast("run_end", createRunEndPayload("aborted", runLifecycle.state))');
    expect(settlement).toContain("if (!(cancelled && !ownsGeneration))");
  });
});
