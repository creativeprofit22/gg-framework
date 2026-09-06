import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Run settlement lives inside the daemon closure, with no injectable session seam.
// Pin its routing here; session verification and UI settlement have runtime suites.
describe("desktop verification settlement", () => {
  it("reports an unresolved gate as Unverified, not an unexpected error", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("const verificationProblem = cancelled ? null");
    const end = source.indexOf("// Autopilot's review loop", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const settlement = source.slice(start, end);
    expect(settlement).not.toContain("broadcastError(");
    expect(settlement).toContain('log("WARN", "app-sidecar", "verification incomplete"');
    expect(settlement).toContain('verificationProblem ? "unverified"');
    expect(settlement).toContain("unverified: true");
  });
});
