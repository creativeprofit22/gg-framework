import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runContextProfileRequest } from "./app-sidecar-context-profile.js";
import { runOpenAICodexFastRequest } from "./app-sidecar-fast.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

const APP_SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app-sidecar.ts");
const eligibleState = {
  provider: "openai",
  model: "gpt-6-astra",
  accountId: "account-1",
};

function routeBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `route not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let index = end; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) {
      end = index;
      break;
    }
  }
  return source.slice(start, end + 1);
}

const routes = [
  {
    name: "context profile",
    marker: 'if (method === "POST" && url === "/context-profile") {',
    run: (running: boolean) =>
      runContextProfileRequest({
        body: { profile: "experimental" },
        state: eligibleState,
        running,
        activeUsage: 0,
        mutations: new AppSidecarSessionMutationCoordinator(),
        switchProfile: vi.fn(async () => {}),
      }),
  },
  {
    name: "Fast",
    marker: 'if (method === "POST" && url === "/openai-codex-fast") {',
    run: (running: boolean) =>
      runOpenAICodexFastRequest({
        body: { enabled: true },
        state: eligibleState,
        running,
        mutations: new AppSidecarSessionMutationCoordinator(),
        switchFast: vi.fn(async () => {}),
      }),
  },
] as const;

describe("app sidecar Astra control routes", () => {
  it.each(routes)("guards $name across every run owner", async ({ marker }) => {
    const block = routeBlock(await fs.readFile(APP_SIDECAR, "utf8"), marker);
    expect(block).toContain(
      "running: running || runClaim.active || autopilotActive || runLifecycle.running",
    );
  });

  it.each(routes)("returns 409 while $name is busy and succeeds while idle", async ({ run }) => {
    await expect(run(true)).resolves.toMatchObject({ status: 409 });
    await expect(run(false)).resolves.toMatchObject({ status: 200 });
  });
});
