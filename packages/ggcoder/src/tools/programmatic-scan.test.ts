import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigurationFingerprintV1,
  ProgrammaticProfileV1,
} from "../core/programmatic/contracts.js";
import {
  configurationFingerprintV1Schema,
  programmaticLifecycleStateV1Schema,
  programmaticProfileEnvelopeV2Schema,
} from "../core/programmatic/contracts.js";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "../core/programmatic/lifecycle.js";
import { PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "../core/programmatic/profile.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { createProgrammaticProfileTool } from "./programmatic-profile.js";
import { createProgrammaticScanTool } from "./programmatic-scan.js";
import { ProgrammaticAdvisoryTurn, AdvisoryEvidence } from "../core/programmatic/advisory.js";
import { executeAdvisoryTool } from "../core/programmatic/advisory-tools.js";

const roots: string[] = [];
const context = {
  signal: new AbortController().signal,
  toolCallId: "programmatic-scan-test",
};

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-scan-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src-tauri"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  await fs.writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    '{"identifier":"dev.fixture"}\n',
  );
  return root;
}

async function generateProfile(root: string): Promise<void> {
  const tool = createProgrammaticProfileTool(root, {
    reviewer: async (request) => ({ action: "answer", answers: { [request.questions[0]!.id]: "save-setup" } }),
  });
  const inspected = JSON.parse((await tool.execute({ action: "inspect" }, context)) as string) as {
    configuration_fingerprint: ConfigurationFingerprintV1;
    profile: ProgrammaticProfileV1;
    expected_prior_profile_digest: string | null;
  };
  const generated = JSON.parse(
    (await tool.execute(
      {
        action: "generate",
        configuration_fingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
        expected_prior_profile_digest: inspected.expected_prior_profile_digest,
      },
      context,
    )) as string,
  ) as { ok: boolean };
  expect(generated.ok).toBe(true);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("scan cancellation", () => {
  it.each(["before", "paused", "committed"] as const)("honestly reports cancellation %s publication", async (when) => {
    const root = await repository();
    await generateProfile(root);
    const profile = await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH));
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let notifications = 0;
    const tool = createProgrammaticScanTool(root, {
      onPreFileMutation: async () => { if (when === "paused") { entered(); await held; } },
      onFileMutated: () => { notifications++; if (when === "committed") controller.abort(); },
    });
    if (when === "before") controller.abort();
    const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence());
    turn.claim("programmatic_scan", {});
    const executionContext = { ...context, signal: controller.signal };
    const running = when === "committed"
      ? executeAdvisoryTool(turn, root, tool, {}, executionContext)
      : tool.execute({}, executionContext);
    if (when === "paused") { await ready; controller.abort(); release(); }
    const result = JSON.parse(await running as string);
    expect(result).toMatchObject({ ok: when === "committed", changed: when === "committed" });
    expect(notifications).toBe(when === "committed" ? 1 : 0);
    if (when === "committed") expect([...turn.limitations]).not.toContain("programmatic_scan: cancelled.");
    expect(await fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH))).toEqual(profile);
    expect((await fs.readdir(path.join(root, ".gg/programmatic"))).sort()).toEqual(
      when === "committed" ? ["profile.json", "state.json"] : ["profile.json"],
    );
  });
});

describe("`/programmatic` validates the stored profile and configuration fingerprint before running a read-only scan", () => {
  it("invokes one argument-free scan separately from read-only advice", () => {
    const command = PROMPT_COMMANDS.find(({ name }) => name === "programmatic");

    expect(command).toMatchObject({
      aliases: [],
      description: "Scan programmatic opportunities",
    });
    expect(command?.prompt).toContain(
      "The host supplies permitted assessment tools for this turn.",
    );
    expect(command?.prompt).toContain("The host already attempted the permitted `programmatic_scan({})` exactly once; do not call it again.");
    expect(command?.prompt).toContain("Report the supplied bounded result separately as Deterministic scan");
    expect(command?.prompt).toContain(
      "Never mutate files, setup, lifecycle, tasks or approvals; never execute specialists, shell commands, indexing or installations",
    );
  });

  it("fails before inventory for an invalid profile and persists only a validated fingerprint", async () => {
    const root = await repository();
    await generateProfile(root);
    const profilePath = path.join(root, PROGRAMMATIC_PROFILE_PATH);
    const validProfile = await fs.readFile(profilePath);
    await fs.writeFile(profilePath, '{"version":1,"scanners":[],"unexpected":true}\n');
    let inventoryReads = 0;

    const invalid = await runProgrammaticScan(root, {
      inventoryOperations: {
        readFile: async () => {
          inventoryReads += 1;
          throw new Error("inventory must not run");
        },
      },
    });

    expect(invalid).toMatchObject({ ok: false, error: "profile-invalid", changed: false });
    expect(inventoryReads).toBe(0);
    await expect(fs.access(path.join(root, PROGRAMMATIC_STATE_PATH))).rejects.toThrow();

    await fs.writeFile(profilePath, validProfile);
    const output = await createProgrammaticScanTool(root).execute({}, context);
    if (typeof output !== "string") throw new Error("Expected string tool output");
    const result = JSON.parse(output) as Record<string, unknown>;
    const fingerprint = configurationFingerprintV1Schema.parse(result.configuration_fingerprint);
    const state = programmaticLifecycleStateV1Schema.parse(
      JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")) as unknown,
    );

    expect(result).toMatchObject({ ok: true, changed: true, recovered: false });
    expect(result).not.toHaveProperty("inventory");
    expect(state.configurationFingerprint).toEqual(fingerprint);
  });

  it("serializes a committed failure without claiming the state was unchanged", async () => {
    const root = await repository();
    await generateProfile(root);
    const output = await createProgrammaticScanTool(root, {
      onFileMutated: (file) => {
        if (file === path.join(root, PROGRAMMATIC_STATE_PATH)) {
          throw new Error("injected notification failure");
        }
      },
    }).execute({}, context);
    if (typeof output !== "string") throw new Error("Expected string tool output");
    const state = programmaticLifecycleStateV1Schema.parse(
      JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")),
    );
    expect(state.records).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false, changed: true, recovered: false,
      state_path: PROGRAMMATIC_STATE_PATH,
      configuration_fingerprint: state.configurationFingerprint,
      summary: { new: 1, active: 1, failed: 1 },
      error: { code: "post-commit-failed", detail: expect.stringContaining("Read the current report") },
    });
  });

  it("rejects configuration drift in the final commit window without creating lifecycle state", async () => {
    const root = await repository();
    await generateProfile(root);

    const result = await runProgrammaticScan(root, {
      onPreFileMutation: async () => {
        await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "stale-configuration",
      changed: false,
    });
    await expect(fs.access(path.join(root, PROGRAMMATIC_STATE_PATH))).rejects.toThrow();
  });

  it("keeps an identical current approval a byte-preserving no-op in the lifecycle commit window", async () => {
    const root = await repository();
    await generateProfile(root);
    const profilePath = path.join(root, PROGRAMMATIC_PROFILE_PATH);
    const stored = programmaticProfileEnvelopeV2Schema.parse(
      JSON.parse(await fs.readFile(profilePath, "utf8")) as unknown,
    );
    await fs.writeFile(profilePath, JSON.stringify(stored, null, 2));
    const proposal = await buildProgrammaticProfileProposal(root);
    let replacementResult: Awaited<ReturnType<typeof persistProgrammaticProfile>> | undefined;

    const result = await runProgrammaticScan(root, {
      onPreFileMutation: async () => {
        replacementResult = await persistProgrammaticProfile(
          root,
          proposal.configurationFingerprint,
          proposal.profile,
          { expectedPriorProfileDigest: proposal.expectedPriorProfileDigest },
        );
      },
    });

    expect(replacementResult).toMatchObject({ ok: true, changed: false });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(await fs.readFile(profilePath, "utf8")).toBe(JSON.stringify(stored, null, 2));
    expect(programmaticLifecycleStateV1Schema.parse(JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8"))).records).toHaveLength(1);
  });
});
