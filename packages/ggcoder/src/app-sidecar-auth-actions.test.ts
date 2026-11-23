import { describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import * as GgCoreActual from "@kenkaiiii/gg-core";
import type { AuthStorage } from "@kenkaiiii/gg-core";
import type { OAuthLoginCallbacks } from "./core/oauth/types.js";
import { getAuthProvider } from "@kenkaiiii/gg-core";
import {
  apiKeyTarget,
  runProviderLogout,
  runProviderSignIn,
  signInErrorMessage,
} from "./app-sidecar-auth-actions.js";

const signIn = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const loginChatGPT = vi.hoisted(() => vi.fn());
const revokeChatGPTSignIn = vi.hoisted(() => vi.fn());
vi.mock("./core/oauth/openai.js", () => ({ loginChatGPT, revokeChatGPTSignIn }));
vi.mock("@kenkaiiii/gg-core", async () => {
  const actual = await vi.importActual<typeof GgCore>("@kenkaiiii/gg-core");
  return { ...actual, signInWithClaudeCode: signIn, signOutOfClaudeCode: signOut };
});

function fakeAuth() {
  const stored: Record<string, unknown> = {};
  const auth = {
    stored,
    setCredentials: vi.fn(async (key: string, creds: unknown) => {
      stored[key] = creds;
    }),
    clearCredentials: vi.fn(async (key: string) => {
      delete stored[key];
    }),
    getCredentials: vi.fn(async (key: string) => stored[key]),
    takeLegacySignIn: vi.fn(async () => false),
  };
  return { auth, storage: auth as unknown as AuthStorage };
}

const cb: OAuthLoginCallbacks = {
  onOpenUrl: () => {},
  onStatus: () => {},
  onPromptCode: async () => "",
};

describe("Anthropic sign-in (Claude Code)", () => {
  it("signs in through Claude Code without writing credentials itself", async () => {
    signIn.mockResolvedValue({ loggedIn: true });
    const { auth, storage } = fakeAuth();
    await runProviderSignIn("anthropic", storage, cb);
    expect(signIn).toHaveBeenCalledWith(storage, cb);
    expect(auth.setCredentials).not.toHaveBeenCalled();
  });

  it("never shows CLI login advice in the sign-in dialog", () => {
    expect(signInErrorMessage(new GgCoreActual.NotLoggedInError("anthropic"), "Anthropic")).toBe(
      "Anthropic sign-in didn't finish. Try again.",
    );
    expect(
      signInErrorMessage(new Error('Token expired. Run "ggcoder login" to re-authenticate.'), "A"),
    ).not.toContain("ggcoder");
    expect(signInErrorMessage(new Error("Claude Code download failed (HTTP 503)."), "A")).toBe(
      "Claude Code download failed (HTTP 503).",
    );
  });

  it("signs out of Claude Code but keeps the API key when only the sign-in is removed", async () => {
    signOut.mockClear();
    const { auth, storage } = fakeAuth();
    await runProviderLogout("anthropic", "oauth", storage);
    expect(signOut).toHaveBeenCalledWith(storage);
    expect(auth.clearCredentials).not.toHaveBeenCalled();
  });

  it("removes only the API key when asked", async () => {
    signOut.mockClear();
    const { auth, storage } = fakeAuth();
    await runProviderLogout("anthropic", "apikey", storage);
    expect(signOut).not.toHaveBeenCalled();
    expect(auth.clearCredentials).toHaveBeenCalledWith("anthropic");
  });
});

describe("Continue with ChatGPT", () => {
  it("stores the plan sign-in apart from the OpenAI API key", async () => {
    const creds = { accessToken: "plan", refreshToken: "r", expiresAt: 1, clientId: "oaiapp_x" };
    loginChatGPT.mockResolvedValue(creds);
    const { auth, storage } = fakeAuth();
    auth.stored["openai-chatgpt"] = { ...creds, idToken: "old-id-token" };
    await runProviderSignIn("openai", storage, cb);
    // The current sign-in's ID token goes back as a hint.
    expect(loginChatGPT).toHaveBeenCalledWith(cb, {
      previous: expect.objectContaining({ idToken: "old-id-token" }),
    });
    expect(auth.setCredentials).toHaveBeenCalledWith("openai-chatgpt", creds);
  });

  it("revokes the plan session at OpenAI before signing out, keeping the API key", async () => {
    revokeChatGPTSignIn.mockResolvedValue(true);
    const { auth, storage } = fakeAuth();
    const plan = { accessToken: "plan", refreshToken: "r", expiresAt: 1, clientId: "oaiapp_x" };
    auth.stored["openai-chatgpt"] = plan;
    auth.stored.openai = { accessToken: "sk-key", refreshToken: "", expiresAt: 1 };
    expect(await runProviderLogout("openai", "oauth", storage)).toEqual({ revoked: true });
    expect(revokeChatGPTSignIn).toHaveBeenCalledWith(plan);
    expect(auth.stored["openai-chatgpt"]).toBeUndefined();
    expect(auth.stored.openai).toBeDefined();
  });

  it("dismisses a retired sign-in without touching anything else", async () => {
    const { auth, storage } = fakeAuth();
    await runProviderLogout("moonshot", "legacy", storage);
    expect(auth.takeLegacySignIn).toHaveBeenCalledWith("moonshot");
    expect(auth.clearCredentials).not.toHaveBeenCalled();
  });

  it("removes both Kimi keys on an API-key disconnect", async () => {
    const { auth, storage } = fakeAuth();
    await runProviderLogout("moonshot", "apikey", storage);
    expect(auth.clearCredentials.mock.calls.map((c) => c[0])).toEqual(["kimi-code", "moonshot"]);
  });

  it("stores a Kimi Code plan key under its own storage key", () => {
    const meta = getAuthProvider("moonshot")!;
    expect(apiKeyTarget(meta, "moonshot", "kimi-code").storageKey).toBe("kimi-code");
  });

  it("refuses a sign-in for a provider that only takes keys", async () => {
    const { storage } = fakeAuth();
    await expect(runProviderSignIn("xai", storage, cb)).rejects.toThrow(/not implemented/);
  });
});

describe("Continue with ChatGPT for another account", () => {
  it("registers afresh without the current sign-in and passes the abort signal", async () => {
    const creds = { accessToken: "plan2", refreshToken: "r", expiresAt: 1, clientId: "oaiapp_y" };
    loginChatGPT.mockResolvedValue(creds);
    const { auth, storage } = fakeAuth();
    auth.stored["openai-chatgpt"] = { ...creds, idToken: "old-id-token" };
    const abort = new AbortController();
    await runProviderSignIn("openai", storage, cb, { newAccount: true, signal: abort.signal });
    expect(loginChatGPT).toHaveBeenLastCalledWith(cb, { newAccount: true, signal: abort.signal });
    expect(auth.setCredentials).toHaveBeenCalledWith("openai-chatgpt", creds);
  });
});
