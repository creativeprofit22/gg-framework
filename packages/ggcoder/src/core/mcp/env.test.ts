import { describe, expect, it } from "vitest";
import { buildMcpStdioEnv } from "./env.js";

describe("buildMcpStdioEnv", () => {
  it("omits parent secrets while preserving and prioritizing configured server values", () => {
    const env = buildMcpStdioEnv(
      {
        MCP_CUSTOM_VALUE: "configured",
        PATH: "configured-path",
      },
      {
        AZURE_OPENAI_API_KEY: "azure-canary",
        AZURE_OPENAI_BASE_URL: "https://azure-canary.example",
        AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        PATH: "inherited-path",
        SystemRoot: "C:\\Windows",
      },
    );

    expect(env).not.toHaveProperty("AZURE_OPENAI_API_KEY");
    expect(env).not.toHaveProperty("AZURE_OPENAI_BASE_URL");
    expect(env).not.toHaveProperty("AZURE_OPENAI_DEPLOYMENT");
    expect(env).toMatchObject({
      MCP_CUSTOM_VALUE: "configured",
      PATH: "configured-path",
      SystemRoot: "C:\\Windows",
      TERM: "dumb",
      GG_CODER: "true",
    });
  });

  it("passes Azure values only when explicitly configured for the server", () => {
    const env = buildMcpStdioEnv(
      { AZURE_OPENAI_API_KEY: "server-specific-key" },
      { AZURE_OPENAI_API_KEY: "parent-key" },
    );

    expect(env.AZURE_OPENAI_API_KEY).toBe("server-specific-key");
  });
});
