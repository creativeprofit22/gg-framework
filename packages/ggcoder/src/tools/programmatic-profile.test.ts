import fs, { rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../core/ask-user.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
import type {
  ConfigurationFingerprintV1,
  ProgrammaticProfileV1,
} from "../core/programmatic/contracts.js";
import {
  persistProgrammaticProfile,
  type ProgrammaticProfileOperations,
} from "../core/programmatic/profile.js";
import { buildProgrammaticInventory, PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import { getPromptCommand, PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { canonicalJson } from "../core/tauri-package/paths.js";
import {
  createProgrammaticProfileTool,
  ProgrammaticProfileParams,
} from "./programmatic-profile.js";

const roots: string[] = [];
const approveSetup: NonNullable<Parameters<typeof createProgrammaticProfileTool>[1]>["reviewer"] = async (request) => ({
  action: "answer", answers: { [request.questions[0]!.id]: "save-setup" },
});
async function reviewedTool(root: string, options: Parameters<typeof createProgrammaticProfileTool>[1] = {}) {
  const tool = createProgrammaticProfileTool(root, { reviewer: approveSetup, ...options });
  await execute(tool, { action: "inspect" });
  return tool;
}

type ToolInput =
  | { action: "inspect" }
  | {
      action: "generate";
      configuration_fingerprint: ConfigurationFingerprintV1;
      profile: ProgrammaticProfileV1;
      expected_prior_profile_digest: string | null;
    };

interface InspectOutput {
  action: "inspect";
  expected_prior_profile_digest: string | null;
  changed: false;
  configuration_fingerprint: ConfigurationFingerprintV1;
  configuration_inputs: Array<{ path: string; sha256: string }>;
  exclusions: string[];
  profile: ProgrammaticProfileV1;
  profile_path: string;
  routes: Array<{ detector_id: string; resolution: { status: string } }>;
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
  const generated = await execute(await reviewedTool(root), {
    action: "generate",
    configuration_fingerprint: inspected.configuration_fingerprint,
    profile: inspected.profile,
    expected_prior_profile_digest: inspected.expected_prior_profile_digest,
  });
  expect(generated).toMatchObject({ ok: true, changed: true });
  const destination = path.join(root, PROGRAMMATIC_PROFILE_PATH);
  const previousBytes = `${canonicalJson({
    version: 1,
    configurationFingerprint: inspected.configuration_fingerprint,
    profile: inspected.profile,
  })}\n`;
  await fs.writeFile(destination, previousBytes);
  return { root, inspected: await inspect(root), destination, previousBytes };
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
        resolution: expect.objectContaining({
          status: "routable",
          specialistCommand: "setup-tauri-package",
          arguments: [{ name: "app-root", value: "." }],
          mutates: true,
          availability: { status: "available", source: "built-in", portability: "bundled" },
        }),
      }),
    ]);
    expect(result.configuration_inputs.every((entry) => !path.isAbsolute(entry.path))).toBe(true);
    expect(result.exclusions.length).toBeGreaterThan(0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();

    const setup = getPromptCommand("setup-programmatic");
    expect(setup?.prompt).toContain('The host already collected exact `programmatic_profile` inspection facts.');
    expect(setup?.prompt).toContain("Do not repeat inspection or discover tools.");
    expect(setup?.prompt).toContain("no scan is required or permitted in setup.");
    expect(setup?.prompt).toContain("every route, exclusions, drift inputs");
    expect(setup?.prompt).toContain("setup performed no writes");
    expect(setup?.prompt).toContain("Stop for separate user approval");
    expect(setup?.prompt).not.toContain('action: "generate"');
    expect(
      PROMPT_COMMANDS.filter((command) => command.name.includes("programmatic")).map(
        (command) => command.name,
      ),
    ).toEqual(["setup-programmatic", "programmatic"]);
  });

  it("A separate explicit generation action writes only a validated, versioned declarative profile under .gg/programmatic/ using repository-relative paths and atomic replacement", async () => {
    const root = await repository();
    const before: string[] = [];
    const after: string[] = [];
    const inspected = await inspect(root);
    const tool = await reviewedTool(root, {
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
    expected_prior_profile_digest: inspected.expected_prior_profile_digest,
    };

    expect(await execute(tool, input)).toMatchObject({
      action: "generate",
      ok: true,
      changed: true,
      path: PROGRAMMATIC_PROFILE_PATH,
    });
    expect(await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "utf8")).toBe(
      canonicalJson({
        version: 3,
        historyPolicy: { version: 1, enabled: true },
        configurationFingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
        configurationSnapshot: (await buildProgrammaticInventory(root)).configurationSnapshot,
      }),
    );
    expect(await execute(tool, input)).toMatchObject({
      action: "generate", ok: false, changed: false,
      error: expect.stringContaining("setup-proposal-unavailable"),
    });
    expect(await persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
      expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
    })).toMatchObject({ ok: true, changed: false });
    expect(before).toEqual([path.join(root, PROGRAMMATIC_PROFILE_PATH)]);
    expect(after).toEqual(before);
  });

  it("Profile generation refuses stale approval input when the configuration fingerprint differs from the proposal", async () => {
    const root = await repository();
    const inspected = await inspect(root);
    const tool = await reviewedTool(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');

    expect(
      await execute(tool, {
        action: "generate",
        configuration_fingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
    expected_prior_profile_digest: inspected.expected_prior_profile_digest,
      }),
    ).toMatchObject({ error: "operation-failed", message: expect.stringContaining("changed since inspection"), changed: false });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();

    const current = await inspect(root);
    await execute(tool, { action: "inspect" });
    expect(
      await execute(tool, {
        action: "generate",
        configuration_fingerprint: current.configuration_fingerprint,
        profile: { version: 1, scanners: [] },
        expected_prior_profile_digest: current.expected_prior_profile_digest,
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
    expected_prior_profile_digest: inspected.expected_prior_profile_digest,
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

describe("profile cancellation", () => {
  it.each(["before", "paused", "committed"] as const)("threads approved tool cancellation %s publication", async (when) => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const tool = await reviewedTool(root, {
      onPreFileMutation: async () => { if (when === "paused") { entered(); await held; } },
      onFileMutated: (file) => { if (when === "committed" && path.basename(file) === "profile.json") controller.abort(); },
    });
    if (when === "before") controller.abort();
    const running = tool.execute({ action: "generate", configuration_fingerprint: inspected.configuration_fingerprint,
      profile: inspected.profile, expected_prior_profile_digest: inspected.expected_prior_profile_digest,
    }, { signal: controller.signal, toolCallId: "cancel-approved-profile" });
    if (when === "paused") { await ready; controller.abort(); release(); }
    expect(JSON.parse(await running as string)).toMatchObject(when === "committed"
      ? { ok: true, changed: true }
      : { changed: false, error: "operation-failed", message: expect.stringMatching(/abort|cancel/i) });
    if (when === "committed") {
      expect(await fs.readFile(destination, "utf8")).not.toBe(previousBytes);
      expect(await fs.readFile(path.join(root, ".gg/programmatic/profile.previous.json"), "utf8")).toBe(previousBytes);
      expect(await fs.readdir(path.join(root, ".gg/programmatic"))).toEqual(["profile.json", "profile.previous.json"]);
    } else {
      expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
      await expectNoTemporaryFiles(root);
    }
  });

  it.each(["before", "paused", "committed"] as const)("preserves the true core persistence outcome when aborted %s commit", async (when) => {
    const { root, inspected, destination, previousBytes } = await previousValidProfile();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    if (when === "before") controller.abort();
    const running = persistProgrammaticProfile(root, inspected.configuration_fingerprint, inspected.profile, {
      expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
      signal: controller.signal,
      validateBeforeCommit: async () => { if (when === "paused") { entered(); await held; } },
      onCommitted: () => { if (when === "committed") controller.abort(); },
    }).then((result) => result, (error: unknown) => error);
    if (when === "paused") { await ready; controller.abort(); release(); }
    const result = await running;
    if (when === "committed") {
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(await fs.readFile(destination, "utf8")).not.toBe(previousBytes);
    } else {
      expect(result).toBe(controller.signal.reason);
      expect(await fs.readFile(destination, "utf8")).toBe(previousBytes);
    }
    await expectNoTemporaryFiles(root);
  });
});

describe("host setup authorization", () => {
  it("fails closed without a reviewer even after inspection", async () => {
    const root = await repository();
    const tool = createProgrammaticProfileTool(root);
    const proposal = await execute(tool, { action: "inspect" }) as unknown as InspectOutput;
    expect(await execute(tool, { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
      profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest,
    })).toMatchObject({ error: "unsupported-host", changed: false });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });

  it.each(["deny", "cancel", "owner", "configuration", "prior", "reset", "plan", "abort", "precommit"] as const)("consumes and refuses %s approvals without writing", async (outcome) => {
    const root = await repository();
    const signal = new AbortController();
    let owner = "session-a";
    const planModeRef = { current: false };
    const reviewer = vi.fn(async (request: AskUserRequest) => {
      expect(request.questions[0]!.detail).toContain("configurationFingerprint");
      if (outcome === "owner") owner = "session-b";
      if (outcome === "configuration") await fs.writeFile(path.join(root, "package.json"), '{"name":"drift"}');
      if (outcome === "prior") {
        await fs.mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
        await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "preserve competing bytes");
      }
      if (outcome === "reset") tool.cancel();
      if (outcome === "plan") planModeRef.current = true;
      if (outcome === "abort") signal.abort();
      return outcome === "cancel" ? { action: "cancel" as const } : {
        action: "answer" as const, answers: { [request.questions[0]!.id]: outcome === "deny" ? "deny" : "save-setup" },
      };
    });
    const tool = await reviewedTool(root, { reviewer, owner: () => owner, planModeRef,
      onPreFileMutation: () => { if (outcome === "precommit") tool.cancel(); },
    });
    const proposal = await inspect(root);
    const input: ToolInput = { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
      profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest };
    const output = JSON.parse(await tool.execute(input, { signal: signal.signal, toolCallId: "review" }) as string);
    expect(output).toMatchObject({ changed: false });
    expect(output.ok).not.toBe(true);
    expect(reviewer).toHaveBeenCalledTimes(1);
    planModeRef.current = false;
    expect(await execute(tool, input)).toMatchObject({ changed: false, error: expect.stringContaining("setup-proposal-unavailable") });
    expect(reviewer).toHaveBeenCalledTimes(1);
    if (outcome === "prior") expect(await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "utf8")).toBe("preserve competing bytes");
    else await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });

  it("does not transfer a proposal between tool owners or retain it after disposal", async () => {
    const root = await repository();
    const reviewer = vi.fn(approveSetup!);
    const tool = await reviewedTool(root, { reviewer });
    const proposal = await inspect(root);
    const input: ToolInput = { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
      profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest };
    const sibling = createProgrammaticProfileTool(root, { reviewer });
    expect(await execute(sibling, input)).toMatchObject({ changed: false, error: expect.stringContaining("setup-proposal-unavailable") });
    tool.dispose();
    expect(await execute(tool, input)).toMatchObject({ changed: false, error: expect.stringContaining("setup-proposal-unavailable") });
    expect(reviewer).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });

  it("rejects replacement of the inspected project even with identical configuration bytes", async () => {
    const root = await repository();
    const replacement = `${root}-original`;
    roots.push(replacement);
    const tool = await reviewedTool(root, { reviewer: async (request) => {
      await fs.rename(root, replacement);
      await fs.cp(replacement, root, { recursive: true });
      return { action: "answer", answers: { [request.questions[0]!.id]: "save-setup" } };
    } });
    const proposal = await inspect(root);
    expect(await execute(tool, { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
      profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest,
    })).toMatchObject({ changed: false, error: "operation-failed", message: expect.stringContaining("project changed") });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
    await expect(fs.access(path.join(replacement, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });

  it("does not accept an answer from a previous review", async () => {
    const root = await repository();
    let previousId = "";
    const tool = await reviewedTool(root, { reviewer: async (request) => {
      const id = previousId;
      previousId = request.questions[0]!.id;
      return { action: "answer", answers: { [id]: "save-setup" } };
    } });
    const proposal = await inspect(root);
    const input: ToolInput = { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
      profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest };
    expect(await execute(tool, input)).toMatchObject({ error: "setup-approval-denied" });
    await execute(tool, { action: "inspect" });
    expect(await execute(tool, input)).toMatchObject({ error: "setup-approval-denied" });
    await expect(fs.access(path.join(root, PROGRAMMATIC_PROFILE_PATH))).rejects.toThrow();
  });
});

describe("Initial setup and explicit regeneration are idempotent and preserve the previous valid profile on validation or write failure", () => {
  it("keeps inspection and approved regeneration idempotent", async () => {
    const root = await repository();
    const first = await inspect(root);
    const second = await inspect(root);
    expect(second).toEqual(first);

    const tool = await reviewedTool(root);
    const input: ToolInput = {
      action: "generate",
      configuration_fingerprint: first.configuration_fingerprint,
      profile: first.profile,
      expected_prior_profile_digest: first.expected_prior_profile_digest,
    };
    expect(await execute(tool, input)).toMatchObject({ ok: true, changed: true });
    expect(await persistProgrammaticProfile(root, first.configuration_fingerprint, first.profile, {
      expectedPriorProfileDigest: first.expected_prior_profile_digest,
    })).toMatchObject({ ok: true, changed: false });
    expect(await execute(tool, input)).toMatchObject({ ok: false, changed: false,
      error: expect.stringContaining("setup-proposal-unavailable") });
  });
  it.each(["initial", "refresh"])("serializes committed %s cleanup failure truthfully", async (operation) => {
    const root = await repository();
    const tool = await reviewedTool(root);
    if (operation === "refresh") {
      const initial = await inspect(root);
      expect(await execute(tool, { action: "generate",
        configuration_fingerprint: initial.configuration_fingerprint, profile: initial.profile,
        expected_prior_profile_digest: initial.expected_prior_profile_digest,
      })).toMatchObject({ ok: true, changed: true });
      await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
    }
    const proposal = await inspect(root);
    await execute(tool, { action: "inspect" });
    const profileDirectory = path.join(await fs.realpath(root), ".gg/programmatic");
    let cleanups = 0;
    await vi.mocked(rm).withImplementation(async (file, options) => {
      if (typeof file === "string" && path.dirname(file) === profileDirectory &&
          path.basename(file).startsWith(".profile-")) {
        cleanups++;
        throw new Error("injected cleanup failure");
      }
      return fs.rm(file, options);
    }, async () => {
      expect(await execute(tool, { action: "generate",
        configuration_fingerprint: proposal.configuration_fingerprint, profile: proposal.profile,
        expected_prior_profile_digest: proposal.expected_prior_profile_digest,
      })).toMatchObject({ action: "generate", ok: false, changed: true,
        error: "post-commit-failed", detail: expect.stringContaining("Read back setup before retrying") });
    });
    expect(cleanups).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "utf8")))
      .toMatchObject({ configurationFingerprint: proposal.configuration_fingerprint, profile: proposal.profile });
    expect(await inspect(root)).toMatchObject({ operation: "current", approval_available: false });
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
        expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
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
        expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
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
        expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
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
        expectedPriorProfileDigest: inspected.expected_prior_profile_digest,
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
