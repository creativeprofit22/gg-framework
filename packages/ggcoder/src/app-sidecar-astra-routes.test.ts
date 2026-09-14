import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runContextProfileRequest } from "./app-sidecar-context-profile.js";
import { runOpenAICodexFastRequest } from "./app-sidecar-fast.js";
import { AppSidecarSessionMutationCoordinator, isAppSidecarSessionBusy } from "./app-sidecar-session-mutation.js";
import { RunClaim } from "./core/run-claim.js";

const APP_SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app-sidecar.ts");
const eligibleState = {
  provider: "openai",
  model: "gpt-6-astra",
  accountId: "account-1",
  openAICodexContextProfileEligibility: { canChange: true as const },
};

const routes = [
  {
    name: "context profile",
    url: "/context-profile",
    body: { profile: "experimental" },
    setting: "profile",
    expectedValue: "experimental",
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
    url: "/openai-codex-fast",
    body: { enabled: true },
    setting: "fast",
    expectedValue: true,
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
  let wiring: string;
  beforeAll(async () => {
    // Match the task-admission harness: execute actual routes and the authoritative
    // busy projection, rather than duplicating its expression in fixture code.
    const source = ts.createSourceFile("app-sidecar.ts", await fs.readFile(APP_SIDECAR, "utf8"), ts.ScriptTarget.Latest, true);
    const projections: string[] = [];
    const blocks = new Map(routes.map(({ url }) => [url, [] as string[]]));
    function visit(node: ts.Node) {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(source) === "sessionBusyState")) {
        projections.push(node.getText(source));
      }
      if (ts.isIfStatement(node)) {
        for (const { url } of routes) {
          if (node.expression.getText(source) === `method === "POST" && url === "${url}"`) {
            blocks.get(url)!.push(node.getText(source));
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(projections).toHaveLength(1);
    for (const block of blocks.values()) expect(block).toHaveLength(1);
    wiring = ts.transpileModule(`
      ${projections[0]}
      function request(req, res) {
        const method = "POST", url = req.url;
        ${[...blocks.values()].flat().join("\n")}
      }
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  });

  const owners = ["running", "run claim", "task sweep", "Autopilot", "run lifecycle", "idle"] as const;
  it.each(routes.flatMap((route) => owners.map((owner) => ({ ...route, owner }))))(
    "$name rejects each busy owner and mutates only while idle: $owner", async (route) => {
      const runClaim = new RunClaim();
      const taskSweepClaim = new RunClaim();
      if (route.owner === "run claim") expect(runClaim.claim()).toBe(true);
      if (route.owner === "task sweep") expect(taskSweepClaim.claim()).toBe(true);
      const switchProfile = vi.fn(async () => {});
      const switchFast = vi.fn(async () => {});
      const sessionMutations = new AppSidecarSessionMutationCoordinator();
      const context = vm.createContext({
        running: route.owner === "running", runClaim, taskSweepClaim,
        autopilotActive: route.owner === "Autopilot",
        runLifecycle: { running: route.owner === "run lifecycle" },
        isAppSidecarSessionBusy, runContextProfileRequest, runOpenAICodexFastRequest,
        sessionMutations,
        session: {
          getState: () => eligibleState,
          getContextUsage: () => ({ used: 0 }),
          switchOpenAICodexContextProfile: switchProfile,
          switchOpenAICodexFast: switchFast,
        },
        readBody: async (req: { body: string }) => req.body,
        json: (res: { resolve: (result: { status: number }) => void }, status: number) => res.resolve({ status }),
        broadcast: vi.fn(), footerExtras: () => ({}),
      });
      vm.runInContext(wiring, context);
      const response = await new Promise<{ status: number }>((resolve) => {
        context.request({ url: route.url, body: JSON.stringify(route.body) }, { resolve });
      });
      if (route.owner === "idle") {
        expect(response.status).toBe(200);
        const selected = route.setting === "profile" ? switchProfile : switchFast;
        const other = route.setting === "profile" ? switchFast : switchProfile;
        expect(selected).toHaveBeenCalledExactlyOnceWith(route.expectedValue);
        expect(other).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(409);
        expect(switchProfile).not.toHaveBeenCalled();
        expect(switchFast).not.toHaveBeenCalled();
      }
      expect(sessionMutations.owner).toBeNull();
    },
  );

  it.each(routes)("returns 409 while $name is busy and succeeds while idle", async ({ run }) => {
    await expect(run(true)).resolves.toMatchObject({ status: 409 });
    await expect(run(false)).resolves.toMatchObject({ status: 200 });
  });
});
