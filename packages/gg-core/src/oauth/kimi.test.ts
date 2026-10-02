import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshKimiToken } from "./kimi.js";
import { execFileSync } from "node:child_process";
import { type as osType } from "node:os";
import type * as OsModule from "node:os";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  type: vi.fn(() => "Linux"),
}));

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("refreshKimiToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(osType).mockReturnValue("Linux");
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("strips the Qwen runtime credential from the macOS version probe environment", async () => {
    vi.mocked(osType).mockReturnValue("Darwin");
    vi.mocked(execFileSync).mockReturnValue("15.0\n");
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "fake-qwen-test-only");
    vi.stubEnv("qwen_cloud_token_plan_key", "fake-qwen-test-only");
    vi.stubEnv("Qwen_Cloud_Token_Plan_Key", "fake-qwen-test-only");
    vi.stubEnv("GG_ENV_SENTINEL", "preserved");
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "new-access", expires_in: 3_600 }),
    ) as unknown as typeof fetch;

    await refreshKimiToken("old-refresh");

    expect(execFileSync).toHaveBeenCalledWith("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf-8",
      timeout: 1000,
      env: expect.any(Object),
    });
    const env = vi.mocked(execFileSync).mock.calls.at(-1)![2]!.env!;
    expect(
      Object.keys(env).filter((name) => name.toUpperCase() === "QWEN_CLOUD_TOKEN_PLAN_KEY"),
    ).toEqual([]);
    expect(env.GG_ENV_SENTINEL).toBe("preserved");
  });

  it("uses the rotated refresh token when the server returns one", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3_600,
      }),
    ) as unknown as typeof fetch;

    const creds = await refreshKimiToken("old-refresh");
    expect(creds.accessToken).toBe("new-access");
    expect(creds.refreshToken).toBe("rotated-refresh");
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
  });

  it("preserves the existing refresh token when the server omits it", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "new-access", expires_in: 3_600 }),
    ) as unknown as typeof fetch;

    const creds = await refreshKimiToken("old-refresh");
    expect(creds.accessToken).toBe("new-access");
    // No rotation → keep using the caller's refresh token so the credential is
    // never stranded (which would force a silent fall back to the API key).
    expect(creds.refreshToken).toBe("old-refresh");
  });

  it("surfaces a 401 in a shape AuthStorage recognizes as a dead refresh token", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "invalid_grant" }, 401),
    ) as unknown as typeof fetch;

    await expect(refreshKimiToken("dead-refresh")).rejects.toThrow(/\(401\)/);
  });
});
