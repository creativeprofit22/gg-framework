import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { handleAppSidecarProgrammaticExecution, parseProgrammaticRunSelection } from "./app-sidecar-programmatic-execution.js";

const text = `/programmatic-run ${"a".repeat(64)} ${"b".repeat(64)}`;
function host() {
  return {
    text, attachmentCount: 0, busy: false, automated: false, codeMode: true,
    claimStart: vi.fn(() => true), respond: vi.fn(),
    runAgent: vi.fn(async (_label: string, run: () => Promise<void>) => run()),
    execute: vi.fn(async () => {}),
  };
}
describe("explicit single-opportunity app command", () => {
  it("keeps the app adapter out of lifecycle storage", async () => {
    const adapter = await readFile(new URL("./app-sidecar-programmatic-execution.ts", import.meta.url), "utf8");
    expect(adapter).toContain("options.claimStart()");
    expect(adapter).toContain("options.runAgent(");
    expect(adapter).not.toMatch(/new AgentSession|writeFile|rename|setTimeout|agentLoop|spawn\(/);
  });
  it("dispatches exactly one selection after a synchronous run claim", async () => {
    const options = host();
    expect(await handleAppSidecarProgrammaticExecution(options)).toBe(true);
    expect(options.execute).toHaveBeenCalledExactlyOnceWith({ opportunityId: "a".repeat(64), configurationSha256: "b".repeat(64) });
    expect(options.claimStart.mock.invocationCallOrder[0]).toBeLessThan(options.execute.mock.invocationCallOrder[0]!);
  });
  it.each([`${text} extra`, `${text}\n${text}`, "/PROGRAMMATIC-RUN a b", "/programmatic-run research", "/programmatic-run"]) ("rejects invalid selection %s", (value) => {
    expect(parseProgrammaticRunSelection(value)).toBe("invalid");
  });
  it.each([{ busy: true }, { attachmentCount: 1 }, { automated: true }, { codeMode: false }])("rejects without dispatch: %o", async (override) => {
    const options = { ...host(), ...override };
    await handleAppSidecarProgrammaticExecution(options);
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.claimStart).not.toHaveBeenCalled();
  });
  it("does not reinterpret ordinary text or a second owner's claim", async () => {
    const options = host();
    options.text = "ordinary text";
    expect(await handleAppSidecarProgrammaticExecution(options)).toBe(false);
    options.text = text;
    options.claimStart.mockReturnValue(false);
    await handleAppSidecarProgrammaticExecution(options);
    expect(options.respond).toHaveBeenCalledWith(409, expect.anything());
    expect(options.execute).not.toHaveBeenCalled();
  });
});
