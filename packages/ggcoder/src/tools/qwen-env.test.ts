import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getSafeToolEnv, withoutQwenRuntimeSecret } from "./safe-env.js";
import { childSubAgentEnv } from "./subagent-shared.js";

const key = "sk-sp-fake-child-canary";
describe("Qwen subprocess credential boundary", () => {
  it("strips case-insensitive inherited secrets and explicit MCP overrides without mutating input", () => {
    const inherited = { PATH: "/fake/bin", QWEN_CLOUD_TOKEN_PLAN_KEY: key };
    const overrides = {
      qwen_cloud_token_plan_key: key,
      Qwen_Cloud_Token_Plan_Key: key,
      MCP_OPTION: "allowed",
    };
    const source = { ...inherited, ...overrides };
    expect(withoutQwenRuntimeSecret(source)).toEqual({ PATH: "/fake/bin", MCP_OPTION: "allowed" });
    expect(JSON.stringify(getSafeToolEnv(source))).not.toContain(key);
    expect(source.QWEN_CLOUD_TOKEN_PLAN_KEY).toBe(key);
  });
  it("intentionally propagates only the canonical dedicated key to trusted agent children", () => {
    const child = childSubAgentEnv({
      QWEN_CLOUD_TOKEN_PLAN_KEY: key,
      qwen_cloud_token_plan_key: "shadow",
      PATH: "/fake/bin",
    });
    expect(child.QWEN_CLOUD_TOKEN_PLAN_KEY).toBe(key);
    expect(child).not.toHaveProperty("qwen_cloud_token_plan_key");
    expect(child.PATH).toBe("/fake/bin");
    expect(JSON.stringify(getSafeToolEnv(child))).not.toContain(key);
  });
  it("filters MCP after merging explicit overrides at the actual transport construction", () => {
    const source = readFileSync(new URL("../core/mcp/client.ts", import.meta.url), "utf8");
    expect(source).toContain("env: withoutQwenRuntimeSecret({ ...process.env, ...config.env })");
  });
});
