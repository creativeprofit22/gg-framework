import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAI } from "./openai.js";
import type { OAuthLoginCallbacks } from "./types.js";

const originalFetch = globalThis.fetch;

/** An access token carrying the account-id claim `loginOpenAI` requires. */
function accessTokenWithAccount(): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

function mockTokenExchange(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: accessTokenWithAccount(),
          refresh_token: "refresh-1",
          expires_in: 3_600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Capture the authorize URL the flow asks the browser to open. */
function callbacksWithPaste(paste: (message: string) => Promise<string>): {
  callbacks: OAuthLoginCallbacks;
  authUrl: () => string;
  prompts: string[];
} {
  let opened = "";
  const prompts: string[] = [];
  return {
    prompts,
    authUrl: () => opened,
    callbacks: {
      onOpenUrl: (url) => {
        opened = url;
      },
      onStatus: () => {},
      onPromptCode: async (message) => {
        prompts.push(message);
        return paste(message);
      },
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("loginOpenAI on a headless host", () => {
  /**
   * Regression for #20. Over SSH the loopback listener binds fine (port 1455 is
   * free on the server) but no browser will ever hit it, so waiting on it alone
   * meant a two-minute silence. The paste route must be offered immediately.
   */
  it("offers the paste prompt immediately instead of waiting out the listener", async () => {
    mockTokenExchange();
    let promptedAt = 0;
    const startedAt = Date.now();

    const holder = callbacksWithPaste(async () => {
      promptedAt = Date.now();
      const state = new URL(holder.authUrl()).searchParams.get("state");
      return `http://localhost:1455/auth/callback?code=abc123&state=${state}`;
    });

    // Nothing will ever hit the listener here; the paste route drives this
    // login, and it has to be offered without waiting for the listener to lapse.
    const creds = await loginOpenAI(holder.callbacks);

    expect(promptedAt).toBeGreaterThan(0);
    expect(promptedAt - startedAt).toBeLessThan(5_000);
    expect(creds.accountId).toBe("acct-123");
  }, 20_000);

  it("does not blame a local server that started fine", async () => {
    mockTokenExchange();
    const holder = callbacksWithPaste(async () => {
      const state = new URL(holder.authUrl()).searchParams.get("state");
      return `http://localhost:1455/auth/callback?code=abc123&state=${state}`;
    });

    await loginOpenAI(holder.callbacks);

    // The listener bound fine — the browser is simply elsewhere. Saying the
    // server failed sent people chasing a port problem they did not have.
    expect(holder.prompts.length).toBeGreaterThan(0);
    expect(holder.prompts[0]).not.toContain("Could not start local server");
    expect(holder.prompts[0]).toContain("SSH/headless");
  }, 20_000);

  it("completes the login from a pasted callback URL", async () => {
    const fetchMock = mockTokenExchange();
    let pasted: string | null = null;

    const holder = callbacksWithPaste(async () => {
      // The operator copies the whole URL the browser landed on, state included.
      const state = new URL(holder.authUrl()).searchParams.get("state");
      pasted = `http://localhost:1455/auth/callback?code=abc123&state=${state}`;
      return pasted;
    });

    const creds = await loginOpenAI(holder.callbacks);

    expect(pasted).not.toBeNull();
    expect(creds.accessToken).toBe(accessTokenWithAccount());
    expect(creds.accountId).toBe("acct-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  // The listener enforces this; a pasted URL must not be a way around it.
  it("rejects a pasted callback whose state belongs to another attempt", async () => {
    mockTokenExchange();
    const { callbacks } = callbacksWithPaste(
      async () => "http://localhost:1455/auth/callback?code=abc123&state=not-my-state",
    );

    await expect(loginOpenAI(callbacks)).rejects.toThrow(/state mismatch/i);
  }, 20_000);

  it("re-asks when the paste contains no code rather than failing the login", async () => {
    mockTokenExchange();
    let attempt = 0;

    const holder = callbacksWithPaste(async () => {
      attempt++;
      if (attempt === 1) return "oops wrong clipboard";
      const state = new URL(holder.authUrl()).searchParams.get("state");
      return `http://localhost:1455/auth/callback?code=abc123&state=${state}`;
    });

    const creds = await loginOpenAI(holder.callbacks);

    expect(attempt).toBe(2);
    expect(holder.prompts[1]).toContain("didn't contain an authorization code");
    expect(creds.accountId).toBe("acct-123");
  }, 20_000);
});
