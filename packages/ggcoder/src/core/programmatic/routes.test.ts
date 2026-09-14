import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomCommand } from "../custom-commands.js";
import type { PromptCommand } from "../prompt-commands.js";
import type { DiscoveredOpportunityV1, SpecialistCommand } from "./contracts.js";
import {
  PROGRAMMATIC_MACHINE_LOCAL_WARNING,
  executionResultV1Schema,
  routeResolutionV1Schema,
} from "./contracts.js";

const mockedPaths = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("../../config.js", () => ({
  getAppPaths: () => ({ agentDir: mockedPaths.agentDir }),
}));

import { getPromptCommand } from "../prompt-commands.js";
import {
  resolveOpportunityRoute,
  resolveProgrammaticRoutes,
  resolveProgrammaticSpecialist,
  resolveSpecialistAvailability,
} from "./routes.js";

const fingerprint = { version: 1 as const, sha256: "a".repeat(64) };
const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(directory);
  return directory;
}

async function writeCommand(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const name = path.basename(filePath, ".md");
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${name}\n---\nRun ${name}.`,
    "utf8",
  );
}

function customCommand(name: string, scope: "global" | "project"): CustomCommand {
  return {
    name,
    description: name,
    prompt: `Run ${name}.`,
    filePath: `${scope}/${name}.md`,
    scope,
  };
}

const fakeBuiltIn = (name: string): PromptCommand => ({
  name,
  aliases: [],
  description: name,
  prompt: `Run ${name}.`,
});

function opportunity(command: SpecialistCommand): DiscoveredOpportunityV1 {
  return {
    version: 1,
    identity: {
      version: 1,
      id: "b".repeat(64),
      detectorId: `${command}-detector`,
      key: ["route", "fixture"].join("-"),
      path: "apps/demo/package.json",
    },
    representativeCase: "apps/demo/src-tauri/tauri.conf.json",
    repeatableTrigger: "The repeatable project condition exists.",
    inputPaths: ["apps/demo/package.json", "apps/demo/src-tauri/tauri.conf.json"],
    currentProcess: "The process is manual.",
    expectedOutput: "A deterministic specialist result.",
    verification: "Verify the deterministic specialist result.",
    risks: ["The generated result could need project review."],
    confidence: "medium",
    mutationPaths: [".github/workflows/programmatic.yml"],
    evidence: {
      version: 1,
      items: [
        {
          basis: "observed",
          source: "route-test",
          code: "present",
          severity: "info",
          message: "The representative file is present.",
          location: { path: "apps/demo/src-tauri/tauri.conf.json" },
        },
      ],
    },
    route: { status: "routable", specialistCommand: command },
  };
}

it("pins exact bodies and ownership and detects command drift", async () => {
  const cwd = await temporaryDir("gg-pinned-route-");
  const file = path.join(mockedPaths.agentDir, "commands", "research.md");
  await writeCommand(file);
  const first = await resolveProgrammaticSpecialist(cwd, opportunity("research"), fingerprint);
  expect(first).toHaveProperty("command.prompt", "Run research.");
  expect(first).toHaveProperty("owner", file);
  await fs.appendFile(file, "\nChanged body.");
  const second = await resolveProgrammaticSpecialist(cwd, opportunity("research"), fingerprint);
  expect(second).not.toEqual(first);
  await writeCommand(path.join(cwd, ".gg", "commands", "research.md"));
  expect(await resolveProgrammaticSpecialist(cwd, opportunity("research"), fingerprint))
    .toMatchObject({ status: "unroutable", availability: { reason: "wrong-owner" } });
  const bundled = await resolveProgrammaticSpecialist(cwd, opportunity("setup-tauri-package"), fingerprint);
  expect(bundled).toHaveProperty("command.prompt", getPromptCommand("setup-tauri-package")!.prompt);
});

beforeEach(async () => {
  mockedPaths.agentDir = await temporaryDir("gg-route-app-");
  vi.stubEnv("HOME", "");
  vi.stubEnv("USERPROFILE", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe(
  "The route registry permits only code-mode `/research`, `/setup-sweep`, and `/setup-tauri-package`, with explicit ownership rules and no arbitrary slash-command names.",
  () => {
  it("accepts exactly the three allowlisted specialists", () => {
    expect(
      resolveSpecialistAvailability(
        "setup-tauri-package",
        [],
        getPromptCommand("setup-tauri-package"),
      ),
    ).toEqual({ status: "available", source: "built-in", portability: "bundled" });
    for (const command of ["research", "setup-sweep"] as const) {
      expect(resolveSpecialistAvailability(command, [customCommand(command, "global")], undefined))
        .toMatchObject({
          status: "available",
          source: "global-custom",
          portability: "machine-local",
          portabilityWarning: PROGRAMMATIC_MACHINE_LOCAL_WARNING,
        });
    }
  });

  it.each(["", "deploy", "Research", "setup-tauri"])("rejects unsupported command %j", (command) => {
    expect(resolveSpecialistAvailability(command, [], undefined)).toEqual({
      status: "unavailable",
      reason: "unsupported",
    });
  });

  it("applies built-in precedence before custom commands", () => {
    expect(
      resolveSpecialistAvailability(
        "setup-tauri-package",
        [customCommand("setup-tauri-package", "project")],
        fakeBuiltIn("setup-tauri-package"),
      ),
    ).toEqual({ status: "available", source: "built-in", portability: "bundled" });
  });

  },
);

describe(
  "Ambiguous, unsupported, conflicting, or missing routes remain `unroutable` and never fall back to generic prompts or tasks.",
  () => {
    it("returns only non-executable resolutions", () => {
      const research = opportunity("research");
      const unsupported = opportunity("research");
      unsupported.route = { status: "routable", specialistCommand: "deploy" as SpecialistCommand };
      const resolutions = [
        resolveOpportunityRoute(research, fingerprint, [], undefined),
        resolveOpportunityRoute(
          research,
          fingerprint,
          [customCommand("research", "global"), customCommand("research", "global")],
          undefined,
        ),
        resolveOpportunityRoute(
          research,
          fingerprint,
          [customCommand("research", "project")],
          undefined,
        ),
        resolveOpportunityRoute(research, fingerprint, [], fakeBuiltIn("research")),
        resolveOpportunityRoute(unsupported, fingerprint, [], undefined),
      ];

      expect(resolutions.map(({ status }) => status)).toEqual(Array(5).fill("unroutable"));
      expect(
        resolutions.map((resolution) =>
          resolution.availability.status === "unavailable"
            ? resolution.availability.reason
            : "available",
        ),
      ).toEqual([
        "missing",
        "ambiguous",
        "wrong-owner",
        "wrong-owner",
        "unsupported",
      ]);
      expect(JSON.stringify(resolutions)).not.toMatch(/prompt|task|fallback/iu);
    });
  },
);

describe(
  "Each route contains one opportunity ID, bounded arguments, evidence paths, scope, success condition, mutation flag, reason, and current command availability.",
  () => {
  it("builds deterministic, bounded routes without prompt bodies or fallback commands", () => {
    const candidate = opportunity("research");
    const commands = [customCommand("research", "global")];
    const first = resolveOpportunityRoute(candidate, fingerprint, commands, undefined);
    const second = resolveOpportunityRoute(candidate, fingerprint, commands, undefined);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "routable",
      opportunityId: candidate.identity.id,
      specialistCommand: "research",
      mutates: false,
      arguments: [
        { name: "detector-id", value: "research-detector" },
        { name: "representative-case", value: candidate.representativeCase },
      ],
      availability: {
        status: "available",
        portability: "machine-local",
        portabilityWarning: PROGRAMMATIC_MACHINE_LOCAL_WARNING,
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/prompt|fallback|arbitrary command/iu);
  });

  it("derives the mutating Tauri route from the built-in registry", () => {
    const candidate = opportunity("setup-tauri-package");
    expect(
      resolveOpportunityRoute(
        candidate,
        fingerprint,
        [],
        getPromptCommand("setup-tauri-package"),
      ),
    ).toMatchObject({
      status: "routable",
      specialistCommand: "setup-tauri-package",
      mutates: true,
      arguments: [{ name: "app-root", value: "apps/demo" }],
      availability: { source: "built-in", portability: "bundled" },
    });
  });

  it("fails closed when bounded route evidence cannot be derived", () => {
    const candidate = opportunity("research");
    candidate.evidence.items = [
      {
        basis: "inferred",
        source: "route-test",
        code: "derived-only",
        severity: "info",
        message: "Only derived evidence exists.",
      },
    ];

    expect(
      resolveOpportunityRoute(
        candidate,
        fingerprint,
        [customCommand("research", "global")],
        undefined,
      ),
    ).toMatchObject({
      status: "unroutable",
      candidateCommand: "research",
      availability: { status: "unavailable", reason: "ambiguous" },
    });
  });
  it("rejects unsorted, duplicate, overlong, unknown, and multi-opportunity controls", () => {
    const route = resolveOpportunityRoute(
      opportunity("research"),
      fingerprint,
      [customCommand("research", "global")],
      undefined,
    );
    expect(route.status).toBe("routable");
    if (route.status !== "routable") return;

    const invalid = [
      { ...route, arguments: [...route.arguments].reverse() },
      { ...route, arguments: [route.arguments[0], route.arguments[0]] },
      { ...route, arguments: [{ name: "detector-id", value: "x".repeat(501) }] },
      { ...route, evidencePaths: [...route.evidencePaths, route.evidencePaths[0]] },
      { ...route, scopePaths: [...route.scopePaths, route.scopePaths[0]] },
      { ...route, reason: "x".repeat(4_001) },
      { ...route, prompt: "Do anything." },
      { ...route, opportunityIds: [route.opportunityId, "c".repeat(64)] },
    ];
    for (const value of invalid) expect(routeResolutionV1Schema.safeParse(value).success).toBe(false);
  });

  it("allows only routable resolutions into execution results", () => {
    const unroutable = resolveOpportunityRoute(opportunity("research"), fingerprint, [], undefined);
    expect(unroutable.status).toBe("unroutable");
    expect(
      executionResultV1Schema.safeParse({
        version: 1,
        route: unroutable,
        status: "blocked",
        summary: "Unavailable.",
        evidence: opportunity("research").evidence,
      }).success,
    ).toBe(false);
  });
  },
);

describe(
  "Command resolution reuses built-in/custom discovery and reports that globally installed specialists may be unavailable elsewhere.",
  () => {
  it.each(["research", "setup-sweep"] as const)(
    "reports installed and missing global /%s commands",
    async (command) => {
      const cwd = await temporaryDir("gg-route-project-");
      const candidate = opportunity(command);
      const missing = await resolveProgrammaticRoutes(cwd, [candidate], fingerprint);
      expect(missing[0]).toMatchObject({
        status: "unroutable",
        candidateCommand: command,
        availability: { reason: "missing", portability: "machine-local" },
      });

      await writeCommand(path.join(mockedPaths.agentDir, "commands", `${command}.md`));
      const installed = await resolveProgrammaticRoutes(cwd, [candidate], fingerprint);
      expect(installed[0]).toMatchObject({
        status: "routable",
        specialistCommand: command,
        availability: { source: "global-custom", portability: "machine-local" },
      });
    },
  );

  it("rejects project-only and project-shadowed global specialists", async () => {
    const cwd = await temporaryDir("gg-route-project-");
    await writeCommand(path.join(cwd, ".gg", "commands", "research.md"));
    expect((await resolveProgrammaticRoutes(cwd, [opportunity("research")], fingerprint))[0])
      .toMatchObject({ status: "unroutable", availability: { reason: "wrong-owner" } });

    await writeCommand(path.join(mockedPaths.agentDir, "commands", "research.md"));
    expect((await resolveProgrammaticRoutes(cwd, [opportunity("research")], fingerprint))[0])
      .toMatchObject({ status: "unroutable", availability: { reason: "wrong-owner" } });
  });

  it("does not treat the Desktop Chat research handoff as a code-mode command", async () => {
    const cwd = await temporaryDir("gg-route-project-");
    expect((await resolveProgrammaticRoutes(cwd, [opportunity("research")], fingerprint))[0])
      .toMatchObject({ status: "unroutable", availability: { reason: "missing" } });
  });
  },
);