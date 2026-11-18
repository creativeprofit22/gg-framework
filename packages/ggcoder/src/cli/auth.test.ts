import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "../core/oauth/types.js";

const mocks = vi.hoisted(() => ({
  selector: vi.fn(),
  load: vi.fn(),
  getCredentials: vi.fn(),
  setCredentials: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  createInterface: vi.fn(),
  closeLogger: vi.fn(),
  openBrowser: vi.fn(),
  loginChatGPT: vi.fn(),
  signInWithClaudeCode: vi.fn(),
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
    getCredentials = mocks.getCredentials;
    setCredentials = mocks.setCredentials;
  },
}));
vi.mock("node:readline/promises", () => ({ default: { createInterface: mocks.createInterface } }));
vi.mock("../core/oauth/openai.js", () => ({
  CHATGPT_USAGE_URL: "https://example.invalid/usage",
  ChatGPTPlanNotEnabledError: class extends Error {},
  loginChatGPT: mocks.loginChatGPT,
  revokeChatGPTSignIn: vi.fn(),
}));
vi.mock("@kenkaiiii/gg-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signInWithClaudeCode: mocks.signInWithClaudeCode,
  signOutOfClaudeCode: vi.fn(),
}));
vi.mock("./shared.js", () => ({
  CLI_VERSION: "test",
  clearVisibleScreen: vi.fn(),
  displayName: (provider: string) => provider,
  renderLogoBlock: vi.fn(),
  openBrowser: mocks.openBrowser,
  requireInteractiveTTY: vi.fn(),
}));

import { OPENAI_CHATGPT_KEY } from "@kenkaiiii/gg-core";
import { runLogin } from "./auth.js";
import * as authProviders from "../core/auth-providers.js";

const credentials = { accessToken: "test-only", refreshToken: "r", expiresAt: 12345 };
const signIns = [mocks.loginChatGPT, mocks.signInWithClaudeCode];

function answers(...values: string[]): void {
  for (const value of values) mocks.question.mockResolvedValueOnce(value);
}

describe("runLogin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.createInterface.mockReturnValue({ question: mocks.question, close: mocks.close });
    mocks.getCredentials.mockResolvedValue(undefined);
    mocks.loginChatGPT.mockImplementation(async (callbacks: OAuthLoginCallbacks) => {
      callbacks.onOpenUrl("https://example.invalid/oauth");
      return credentials;
    });
    mocks.signInWithClaudeCode.mockResolvedValue({ email: "user@example.invalid" });
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
    for (const signIn of signIns) expect(signIn).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });

  it.each([
    {
      value: "future-native",
      label: "Future Native",
      description: "",
      methods: [],
      methodDetails: {},
    },
    undefined,
  ])("rejects other empty-method or unknown providers before prompting: %j", async (meta) => {
    mocks.selector.mockResolvedValue("future-native");
    vi.spyOn(authProviders, "getAuthProvider").mockReturnValue(meta);

    await runLogin();

    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.question).not.toHaveBeenCalled();
    for (const signIn of signIns) expect(signIn).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
  });

  it("does not route a sign-in-only provider without a terminal flow to ChatGPT", async () => {
    mocks.selector.mockResolvedValue("future-oauth");
    vi.spyOn(authProviders, "getAuthProvider").mockReturnValue({
      value: "future-oauth",
      label: "Future OAuth",
      description: "",
      methods: ["oauth"],
      methodDetails: {},
    });

    await runLogin();

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("has no API key option");
    for (const signIn of signIns) expect(signIn).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.question).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });

  it("signs in with ChatGPT by default and stores it in the ChatGPT slot, not the API-key slot", async () => {
    mocks.selector.mockResolvedValue("openai");
    answers("");

    await runLogin();

    expect(mocks.loginChatGPT).toHaveBeenCalledOnce();
    expect(mocks.signInWithClaudeCode).not.toHaveBeenCalled();
    expect(mocks.openBrowser).toHaveBeenCalledWith("https://example.invalid/oauth");
    expect(mocks.setCredentials).toHaveBeenCalledExactlyOnceWith(OPENAI_CHATGPT_KEY, credentials);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeLogger).toHaveBeenCalledOnce();
  });

  it("stores an OpenAI API key under openai without starting a sign-in", async () => {
    mocks.selector.mockResolvedValue("openai");
    answers("2", "  sk-test-only  ");

    await runLogin();

    for (const signIn of signIns) expect(signIn).not.toHaveBeenCalled();
    expect(mocks.setCredentials).toHaveBeenCalledExactlyOnceWith(
      "openai",
      expect.objectContaining({ accessToken: "sk-test-only", refreshToken: "" }),
    );
  });

  it("signs in with Claude through Claude Code and writes no look-alike token", async () => {
    mocks.selector.mockResolvedValue("anthropic");
    answers("");

    await runLogin();

    expect(mocks.signInWithClaudeCode).toHaveBeenCalledOnce();
    expect(mocks.loginChatGPT).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
  });

  it("connects xAI with an API key only", async () => {
    mocks.selector.mockResolvedValue("xai");
    answers("xai-test-only");

    await runLogin();

    for (const signIn of signIns) expect(signIn).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.setCredentials).toHaveBeenCalledExactlyOnceWith(
      "xai",
      expect.objectContaining({ accessToken: "xai-test-only", refreshToken: "" }),
    );
  });
});
