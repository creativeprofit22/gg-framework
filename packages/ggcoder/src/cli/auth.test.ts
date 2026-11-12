import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "../core/oauth/types.js";

const mocks = vi.hoisted(() => ({
  selector: vi.fn(),
  load: vi.fn(),
  setCredentials: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  createInterface: vi.fn(),
  closeLogger: vi.fn(),
  openBrowser: vi.fn(),
  anthropic: vi.fn(),
  openai: vi.fn(),
  gemini: vi.fn(),
  kimi: vi.fn(),
  xai: vi.fn(),
}));

vi.mock("../ui/login.js", () => ({ renderLoginSelector: mocks.selector }));
vi.mock("../config.js", () => ({ ensureAppDirs: async () => ({ logFile: "unused.log" }) }));
vi.mock("../core/logger.js", () => ({
  initLogger: vi.fn(),
  log: vi.fn(),
  closeLogger: mocks.closeLogger,
}));
vi.mock("../core/auth-storage.js", () => ({
  AuthStorage: class {
    load = mocks.load;
    setCredentials = mocks.setCredentials;
  },
}));
vi.mock("node:readline/promises", () => ({ default: { createInterface: mocks.createInterface } }));
vi.mock("../core/oauth/anthropic.js", () => ({ loginAnthropic: mocks.anthropic }));
vi.mock("../core/oauth/openai.js", () => ({ loginOpenAI: mocks.openai }));
vi.mock("../core/oauth/gemini.js", () => ({ loginGemini: mocks.gemini }));
vi.mock("../core/oauth/kimi.js", () => ({ loginKimi: mocks.kimi }));
vi.mock("../core/oauth/xai.js", () => ({ loginXai: mocks.xai }));
vi.mock("./shared.js", () => ({
  CLI_VERSION: "test",
  clearVisibleScreen: vi.fn(),
  displayName: (provider: string) => provider,
  renderLogoBlock: vi.fn(),
  openBrowser: mocks.openBrowser,
  requireInteractiveTTY: vi.fn(),
}));

import { runLogin } from "./auth.js";
import * as authProviders from "../core/auth-providers.js";

const credentials = { accessToken: "test-only", refreshToken: "", expiresAt: 12345 };
const oauthHelpers = [mocks.anthropic, mocks.openai, mocks.gemini, mocks.kimi, mocks.xai];

describe("runLogin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.createInterface.mockReturnValue({ question: mocks.question, close: mocks.close });
    mocks.question.mockResolvedValue("test-only-key");
    for (const helper of oauthHelpers) {
      helper.mockImplementation(async (callbacks: OAuthLoginCallbacks) => {
        callbacks.onOpenUrl("https://example.invalid/oauth");
        return credentials;
      });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("explains native-only Qwen setup without starting any terminal authentication", async () => {
    mocks.selector.mockResolvedValue("qwen-cloud");

    await runLogin();

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Qwen Cloud (Token Plan)");
    expect(output).toContain("desktop app's native connection service");
    expect(output).toContain("not supported by ggcoder login");
    expect(output).toContain("does not read the desktop vault");
    expect(output).toContain("QWEN_CLOUD_TOKEN_PLAN_KEY");
    expect(output).not.toContain("successfully");
    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.question).not.toHaveBeenCalled();
    for (const helper of oauthHelpers) expect(helper).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });

  it.each([
    { value: "future-native", label: "Future Native", description: "", methods: [] },
    undefined,
  ])("rejects other empty-method or unknown providers before prompting: %j", async (meta) => {
    mocks.selector.mockResolvedValue("future-native");
    vi.spyOn(authProviders, "getAuthProvider").mockReturnValue(meta);

    await runLogin();

    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.question).not.toHaveBeenCalled();
    for (const helper of oauthHelpers) expect(helper).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
  });

  it("does not route an unimplemented OAuth provider to OpenAI", async () => {
    mocks.selector.mockResolvedValue("future-oauth");
    vi.spyOn(authProviders, "getAuthProvider").mockReturnValue({
      value: "future-oauth",
      label: "Future OAuth",
      description: "",
      methods: ["oauth"],
    });

    await expect(runLogin()).rejects.toThrow("No supported terminal login method");

    for (const helper of oauthHelpers) expect(helper).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.question).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });

  it("keeps OpenAI OAuth and credential persistence working", async () => {
    mocks.selector.mockResolvedValue("openai");

    await runLogin();

    expect(mocks.openai).toHaveBeenCalledOnce();
    for (const helper of oauthHelpers.filter((helper) => helper !== mocks.openai)) {
      expect(helper).not.toHaveBeenCalled();
    }
    expect(mocks.openBrowser).toHaveBeenCalledWith("https://example.invalid/oauth");
    expect(mocks.question).not.toHaveBeenCalled();
    expect(mocks.setCredentials).toHaveBeenCalledExactlyOnceWith("openai", credentials);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });
});
