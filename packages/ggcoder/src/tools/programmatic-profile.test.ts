import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigurationFingerprintV1,
  ProgrammaticProfileV1,
} from "../core/programmatic/contracts.js";
import {
  persistProgrammaticProfile,
  type ProgrammaticProfileOperations,
} from "../core/programmatic/profile.js";
import { PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import { getPromptCommand, PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { canonicalJson } from "../core/tauri-package/paths.js";
import {
  createProgrammaticProfileTool,
  ProgrammaticProfileParams,
} from "./programmatic-profile.js";

const roots: string[] = [];

type ToolInput =
  | { action: "inspect" }
  | {
      action: "generate";
      configuration_fingerprint: ConfigurationFingerprintV1;
      profile: ProgrammaticProfileV1;
    };

interface InspectOutput {
  action: "inspect";
  changed: false;
  configuration_fingerprint: ConfigurationFingerprintV1;
  configuration_inputs: Array<{ path: string; sha256: string }>;
  exclusions: string[];
  profile: ProgrammaticProfileV1;
  profile_path: string;
  routes: Array<{ detector_id: string; route: { status: string } }>;
  summary: string;
}

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-profile-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src-tauri"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  await fs.writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    '{"identifier":"dev.fixture"}\n',
  );
  return root;
}

async function execute(
  tool: ReturnType<typeof createProgrammaticProfileTool>,
  input: ToolInput,
): Promise<Record<string, unknown> | string> {
  const output = await tool.execute(input, {
    signal: new AbortController().signal,
    toolCallId: "programmatic-profile-test",
  });
  if (typeof output !== "string") throw new Error("Expected string tool output");
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return output;
  }
}

async function inspect(root: string): Promise<InspectOutput> {
  return (await execute(createProgrammaticProfileTool(root), {
    action: "inspect",
  })) as unknown as InspectOutput;
}

async function previousValidProfile(): Promise<{
  root: string;
  inspected: InspectOutput;
  destination: string;
  previousBytes: string;
}> {
  const root = await repository();
  const inspected = await inspect(root);
  const generated = await execute(createProgrammaticProfileTool(root), {
    action: "generate",
    configuration_fingerprint: inspected.configuration_fingerprint,
    profile: inspected.profile,
  });
  expect(generated).toMatchObject({ ok: true, changed: true });
  const destination = path.join(root, PROGRAMMATIC_PROFILE_PATH);
  const previousBytes = `${canonicalJson(inspected.profile)}\n`;
  await fs.writeFile(destination, previousBytes);
  return { root, inspected, destination, previousBytes };
}

async function expectNoTemporaryFiles(root: string): Promise<void> {
  const names = await fs.readdir(path.join(root, ".gg/programmatic"));
  expect(names).toEqual(["profile.json"]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Targeted automated tests prove discovery-only behavior, approval separation, stale-proposal rejection, atomic persistence, and idempotence", () => {
  it("The initial /setup-programmatic invocation inventories, proposes the exact profile and routes, reports exclusions and drift inputs, performs no writes, and stops for approval", async () => {
    const root = await repository();
    const before: string[] = [];
    const after: string[] = [];
    const tool = createProgrammaticProfileTool(root, {
      onPreFileMutation: (filePath) => {
        before.push(filePath);
      },
      onFileMutated: (filePath) => {
        after.push(filePath);
      },
    });

    const first = await tool.execute(
      { action: "inspect" },
      { signal: new AbortController().signal, toolCallId: "inspect-first" },
    );
    const second = await tool.execute(
      { action: "inspect" },
      { signal: new AbortController().signal, toolCallId: "inspect-second" },
    );
    const result = JSON.parse(first as string) as InspectOutput;

    expect(second).toBe(first);
    expect(result).toMatchObject({
      action: "inspect",
      changed: false,
      profile_path: ".gg/programmatic/profile.json",
      summary: "Inspection completed; no files were written.",
    });
    expect(result.profile.scanners).toEqual([
      { version: 1, id: "tauri-package-shape", specialistCommand: "setup-tauri-package" },
    ]);
    expect(result.routes).toEqual([
      expect.objectContaining({
        detector_id: "tauri-package-shape",
        route: { status: "routable", specialistCommand: "setup-tauri-package" },
      }),
    ]);
    expect(result.configuration_inputs.every((entry) => !path.isAbsolute(entry.path))).toBe(true);
    expect(result.exclusions.length).toBeGreaterThan(0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();

    const setup = getPromptCommand("setup-programmatic");
    expect(setup?.prompt).toContain('exactly once with `action: "inspect"`');
    expect(setup?.prompt).toContain("every route, exclusions, drift inputs");
    expect(setup?.prompt).toContain("setup performed no writes");
    expect(setup?.prompt).toContain("Stop for separate user approval");
    expect(setup?.prompt).not.toContain('action: "generate"');
    expect(
      PROMPT_COMMANDS.filter((command) => command.name.includes("programmatic")).map(
        (command) => command.name,
      ),
    ).toEqual(["setup-programmatic"]);
  });

  it("A separate explicit generation action writes only a validated, versioned declarative profile under .gg/programmatic/ using repository-relative paths and atomic replacement", async () => {
    const root = await repository();
    const before: string[] = [];
    const after: string[] = [];
    const inspected = await inspect(root);
    const tool = createProgrammaticProfileTool(root, {
      onPreFileMutation: (filePath) => {
        before.push(filePath);
      },
      onFileMutated: (filePath) => {
        after.push(filePath);
      },
    });
    const input: ToolInput = {
      action: "generate",
      configuration_fingerprint: inspected.configuration_fingerprint,
      profile: inspected.profile,
    };

    expect(await execute(tool, input)).toMatchObject({
      action: "generate",
      ok: true,
      changed: true,
      path: PROGRAMMATIC_PROFILE_PATH,
    });
    expect(await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "utf8")).toBe(
      canonicalJson(inspected.profile),
    );
    expect(await execute(tool, input)).toMatchObject({
      action: "generate",
      ok: true,
      changed: false,
    });
    expect(before).toEqual([path.join(root, PROGRAMMATIC_PROFILE_PATH)]);
    expect(after).toEqual(before);
  });

  it("Profile generation refuses stale approval input when the configuration fingerprint differs from the proposal", async () => {
    const root = await repository();
    const inspected = await inspect(root);
    const tool = createProgrammaticProfileTool(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');

    expect(
      await execute(tool, {
        action: "generate",
        configuration_fingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
      }),
    ).toMatchObject({ error: "stale-proposal", changed: false });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();

    const current = await inspect(root);
    expect(
      await execute(tool, {
        action: "generate",
        configuration_fingerprint: current.configuration_fingerprint,
        profile: { version: 1, scanners: [] },
      }),
    ).toMatchObject({ error: "proposal-mismatch", changed: false });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });

  it("permits inspection but refuses generation in plan mode", async () => {
    const root = await repository();
    const inspected = await inspect(root);
    const tool = createProgrammaticProfileTool(root, { planModeRef: { current: true } });

    expect(await execute(tool, { action: "inspect" })).toMatchObject({ action: "inspect" });
    expect(
      await execute(tool, {
        action: "generate",
        configuration_fingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
      }),
    ).toContain("programmatic_profile is restricted in plan mode");
  });

  it("fails closed outside the local filesystem", async () => {
    const root = await repository();
    expect(
      await execute(createProgrammaticProfileTool(root, { localFilesystem: false }), {
        action: "inspect",
      }),
    ).toMatchObject({ error: "local-filesystem-required", changed: false });
  });

  it("rejects malformed, arbitrary-path, and arbitrary-command inputs", () => {
    expect(
      ProgrammaticProfileParams.safeParse({ action: "inspect", destination: "elsewhere.json" })
        .success,
    ).toBe(false);
    expect(
      ProgrammaticProfileParams.safeParse({
        action: "generate",
        configuration_fingerprint: { version: 1, sha256: "a".repeat(64) },
        profile: {
          version: 1,
          scanners: [{ version: 1, id: "fixture", specialistCommand: "rm -rf" }],
        },
      }).success,
    ).toBe(false);
  });
});

describe("Initial setup and explicit regeneration are idempotent and preserve the previous valid profile on validation or write failure", () => {
  it("keeps inspection and approved regeneration idempotent", async () => {
    const root = await repository();
    const first = await inspect(root);
    const second = await inspect(root);
    expect(second).toEqual(first);

    const tool = createProgrammaticProfileTool(root);
    const input: ToolInput = {
      action: "generate",
      configuration_fingerprint: first.configuration_fingerprint,
      profile: first.profile,
    };
    expect(await execute(tool, input)).toMatchObject({ ok: true, changed: true });
    expect(await execute(tool, input)).toMatchObject({ ok: true, changed: false });
  });
  it("preserves the previous profile when a temporary write fails", async () => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const operations: Partial<ProgrammaticProfileOperations> = {
      writeFile: async () => {
        throw new Error("injected temporary write failure");
      },
    };

    await expect(
      persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
        operations,
      }),
    ).rejects.toThrow("injected temporary write failure");
    expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    await expectNoTemporaryFiles(root);
  });

  it("preserves the previous profile when temporary validation fails", async () => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const operations: Partial<ProgrammaticProfileOperations> = {
      readFile: async (filePath) =>
        path.basename(filePath).startsWith(".profile-")
          ? Buffer.from("{}\n")
          : fs.readFile(filePath),
    };

    await expect(
      persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
        operations,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    await expectNoTemporaryFiles(root);
  });

  it("revalidates after the temporary write and preserves the previous profile", async () => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const operations: Partial<ProgrammaticProfileOperations> = {
      writeFile: async (filePath, bytes, options) => {
        await fs.writeFile(filePath, bytes, options);
        await fs.writeFile(path.join(root, "package.json"), '{"name":"drifted"}\n');
      },
    };

    await expect(
      persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
        operations,
      }),
    ).resolves.toMatchObject({ error: "stale-proposal", changed: false });
    expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    await expectNoTemporaryFiles(root);
  });

  it("preserves the previous profile when atomic replacement fails", async () => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const operations: Partial<ProgrammaticProfileOperations> = {
      rename: async () => {
        throw new Error("injected rename failure");
      },
    };

    await expect(
      persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
        operations,
      }),
    ).rejects.toThrow("injected rename failure");
    expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    await expectNoTemporaryFiles(root);
  });

  it("rejects malformed input before replacing a previous valid profile", async () => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const malformed = {
      version: 1,
      scanners: [{ version: 1, id: "fixture", specialistCommand: "arbitrary" }],
    } as unknown as ProgrammaticProfileV1;

    await expect(
      persistProgrammaticProfile(root, inspected.configuration_fingerprint, malformed),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    await expectNoTemporaryFiles(root);
  });
});
