import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveInteractiveProvider, routeCliModeFlags } from "../cli.js";

describe("CLI mode flag routing", () => {
  it.each([
    ["interactive", {}, "interactive"],
    ["JSON", { json: true }, "json"],
    ["RPC", { rpc: true }, "rpc"],
  ] as const)("forwards shared flags in %s mode", (_label, modeFlags, expectedMode) => {
    expect(
      routeCliModeFlags({
        ...modeFlags,
        provider: "openai",
        model: "gpt-6-astra",
        thinking: "high",
        "max-turns": "12",
        "system-prompt": "Custom system prompt",
      }),
    ).toMatchObject({
      mode: expectedMode,
      provider: "openai",
      model: "gpt-6-astra",
      thinkingLevel: "high",
      maxTurns: 12,
      systemPrompt: "Custom system prompt",
    });
  });

  it("forwards JSON-only agent prompt composition flags", () => {
    expect(
      routeCliModeFlags({
        json: true,
        "agent-prompt": "Review the change",
        "agent-context": "none",
      }),
    ).toMatchObject({
      agentPrompt: "Review the change",
      agentContext: "none",
    });
  });

  it.each([
    ["interactive", {}],
    ["RPC", { rpc: true }],
  ] as const)("rejects JSON-only agent flags in %s mode", (_label, modeFlags) => {
    expect(() =>
      routeCliModeFlags({ ...modeFlags, "agent-prompt": "Review the change" }),
    ).toThrow("--agent-prompt is only supported with --json");
    expect(() => routeCliModeFlags({ ...modeFlags, "agent-context": "none" })).toThrow(
      "--agent-context is only supported with --json",
    );
  });

  it.each([
    ["JSON", { json: true }],
    ["RPC", { rpc: true }],
  ] as const)("rejects interactive-only resume in %s mode", (_label, modeFlags) => {
    expect(() => routeCliModeFlags({ ...modeFlags, resume: "session.jsonl" })).toThrow(
      "--resume is only supported in interactive mode",
    );
  });

  it("gives an explicit provider precedence over saved settings", () => {
    const routed = routeCliModeFlags({ provider: "openai" });
    expect(resolveInteractiveProvider(routed.provider, "anthropic")).toBe("openai");
  });

  it("rejects ambiguous or malformed mode flags", () => {
    expect(() => routeCliModeFlags({ json: true, rpc: true })).toThrow(
      "--json and --rpc cannot be used together",
    );
    expect(() => routeCliModeFlags({ "max-turns": "3x" })).toThrow(
      "Expected a positive integer",
    );
    expect(() => routeCliModeFlags({ json: true, "agent-context": "all" })).toThrow(
      "Expected project or none",
    );
  });

  it("documents every mode-restricted advertised flag", () => {
    const cliSource = fs.readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    expect(cliSource).toContain("Sub-agent body composed with tools/context/environment (JSON only)");
    expect(cliSource).toContain("Project files in composed prompt: project|none (JSON only)");
    expect(cliSource).toContain("Resume a session by id (interactive only)");
  });
});
