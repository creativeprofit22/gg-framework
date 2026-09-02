import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveredOpportunityV1,
  ProgrammaticLifecycleRecordV1,
  ProgrammaticLifecycleStateV1,
} from "./contracts.js";
import {
  PROGRAMMATIC_CONTRACT_VERSION,
  PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT,
  programmaticLifecycleStateV1Schema,
} from "./contracts.js";
import {
  PROGRAMMATIC_PREVIOUS_STATE_PATH,
  PROGRAMMATIC_STATE_PATH,
  reconcileProgrammaticLifecycle,
  runProgrammaticScan,
} from "./lifecycle.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./profile.js";

const roots: string[] = [];
const fingerprint = { version: 1 as const, sha256: "a".repeat(64) };

function opportunity(id: string, message = "Observed evidence"): DiscoveredOpportunityV1 {
  return {
    version: 1,
    identity: {
      version: 1,
      id,
      detectorId: "tauri-package-shape",
      key: String(["fixture", "opportunity"].join("-")),
      path: "package.json",
    },
    representativeCase: "src-tauri/tauri.conf.json",
    repeatableTrigger: "A repeatable trigger exists.",
    inputPaths: ["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"],
    currentProcess: "The process is manual.",
    expectedOutput: "The process becomes repeatable.",
    verification: "Run the targeted verification.",
    risks: ["Generated files may need review."],
    confidence: "medium",
    mutationPaths: ["scripts/package-tauri.mjs"],
    evidence: {
      version: 1,
      items: [
        {
          basis: "observed",
          source: "tauri-package-shape",
          code: "fixture",
          severity: "info",
          message,
          location: { path: "package.json" },
        },
      ],
    },
    route: { status: "routable", specialistCommand: "setup-tauri-package" },
  };
}

function discovery(...opportunities: DiscoveredOpportunityV1[]) {
  return {
    version: PROGRAMMATIC_CONTRACT_VERSION,
    opportunities: [...opportunities].sort((left, right) =>
      left.identity.id.localeCompare(right.identity.id),
    ),
  };
}

async function approveProfile(root: string): Promise<void> {
  const proposal = await buildProgrammaticProfileProposal(root);
  const persisted = await persistProgrammaticProfile(
    root,
    proposal.configurationFingerprint,
    proposal.profile,
  );
  if (!persisted.ok) throw new Error(`Profile approval failed: ${persisted.error}`);
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-programmatic-lifecycle-"));
  roots.push(root);
  await mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  await mkdir(path.join(root, "src-tauri"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(root, "src-tauri/Cargo.toml"), "[package]\nname = 'fixture'\n");
  await writeFile(path.join(root, "src-tauri/tauri.conf.json"), "{}\n");
  await approveProfile(root);
  return root;
}

async function persistedState(root: string): Promise<ProgrammaticLifecycleStateV1> {
  return programmaticLifecycleStateV1Schema.parse(
    JSON.parse(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")) as unknown,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Lifecycle reconciliation preserves stable IDs and user decisions across unchanged findings, adds new opportunities, marks disappeared opportunities without deleting history, and handles reappearance deterministically.", () => {
  it("refreshes evidence under one stable identity and adds new IDs", () => {
    const first = opportunity("a".repeat(64));
    const initial = reconcileProgrammaticLifecycle(null, discovery(first), fingerprint, []);
    const refreshed = opportunity(first.identity.id, "Refreshed evidence");
    const added = opportunity("b".repeat(64));
    const next = reconcileProgrammaticLifecycle(
      initial.state,
      discovery(refreshed, added),
      fingerprint,
      [],
    );

    expect(next.state.records.map(({ opportunity: item }) => item.identity.id)).toEqual([
      first.identity.id,
      added.identity.id,
    ]);
    expect(next.state.records[0]!.opportunity.evidence.items[0]!.message).toBe(
      "Refreshed evidence",
    );
    expect(next.state.records[0]!.lifecycle.state).toBe("discovered");
    expect(next.summary).toMatchObject({ new: 1, unchanged: 1, active: 2 });
  });

  it("preserves dismissal and completion through disappearance and reappearance", () => {
    const dismissed = opportunity("a".repeat(64));
    const completed = opportunity("b".repeat(64));
    const seeded = reconcileProgrammaticLifecycle(
      null,
      discovery(dismissed, completed),
      fingerprint,
      [],
    ).state;
    seeded.records[0]!.lifecycle.state = "dismissed";
    seeded.records[1]!.lifecycle.state = "completed";

    const absent = reconcileProgrammaticLifecycle(seeded, discovery(), fingerprint, []);
    expect(absent.state.records.map(({ presence }) => presence)).toEqual([
      "disappeared",
      "disappeared",
    ]);
    expect(absent.state.records.map(({ lifecycle }) => lifecycle.state)).toEqual([
      "dismissed",
      "completed",
    ]);
    expect(absent.summary.disappeared).toBe(2);

    const returned = reconcileProgrammaticLifecycle(
      absent.state,
      discovery(dismissed, completed),
      fingerprint,
      [],
    );
    expect(returned.state.records.map(({ presence }) => presence)).toEqual(["present", "present"]);
    expect(returned.state.records.map(({ lifecycle }) => lifecycle.state)).toEqual([
      "dismissed",
      "completed",
    ]);
    expect(returned.summary).toMatchObject({ unchanged: 2, dismissed: 1, completed: 1 });
  });
});

describe("State persistence is atomic, schema-versioned, bounded, and recoverable from an interrupted write without silently replacing the last valid state.", () => {
  it("creates canonical state and keeps an identical rescan byte-stable", async () => {
    const root = await createRepository();
    const first = await runProgrammaticScan(root);
    const firstBytes = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const second = await runProgrammaticScan(root);

    expect(first).toMatchObject({ ok: true, changed: true, recovered: false });
    expect(second).toMatchObject({
      ok: true,
      changed: false,
      recovered: false,
      summary: { new: 0, unchanged: 1 },
    });
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(firstBytes);
    expect((await persistedState(root)).version).toBe(1);
  });

  it("recovers a corrupt primary from the previous valid state", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const valid = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), valid);
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "{broken");

    const result = await runProgrammaticScan(root);

    expect(result).toMatchObject({ ok: true, changed: true, recovered: true });
    expect(programmaticLifecycleStateV1Schema.safeParse(await persistedState(root)).success).toBe(
      true,
    );
  });

  it("fails closed when neither existing state copy is valid", async () => {
    const root = await createRepository();
    const corrupt = Buffer.from("{broken");
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), corrupt);
    await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), "also broken");

    const result = await runProgrammaticScan(root);

    expect(result).toMatchObject({ ok: false, error: "state-corrupt", changed: false });
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(corrupt);
  });

  it.each(["write", "validation", "rename"] as const)(
    "preserves the primary after an injected %s failure",
    async (failure) => {
      const root = await createRepository();
      await runProgrammaticScan(root);
      const primaryPath = path.join(root, PROGRAMMATIC_STATE_PATH);
      const before = await readFile(primaryPath);
      await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
      await approveProfile(root);
      const stateTemporary = `${path.sep}.state.tmp`;

      const result = await runProgrammaticScan(root, {
        operations: {
          ...(failure === "write"
            ? {
                writeFile: async (filePath, bytes, options) => {
                  if (filePath.endsWith(stateTemporary)) throw new Error("injected write failure");
                  await writeFile(filePath, bytes, options);
                },
              }
            : {}),
          ...(failure === "validation"
            ? {
                readFile: async (filePath) =>
                  filePath.endsWith(stateTemporary) ? Buffer.from("{}") : readFile(filePath),
              }
            : {}),
          ...(failure === "rename"
            ? {
                rename: async (from) => {
                  if (from.endsWith(stateTemporary)) throw new Error("injected rename failure");
                },
              }
            : {}),
        },
      });

      expect(result).toMatchObject({ ok: false, error: "persistence-failed", changed: false });
      expect(await readFile(primaryPath)).toEqual(before);
    },
  );

  it("removes only stale managed temporary siblings", async () => {
    const root = await createRepository();
    const temporary = path.join(root, ".gg/programmatic/.state.tmp");
    const unrelated = path.join(root, ".gg/programmatic/unrelated.tmp");
    await writeFile(temporary, "stale");
    await writeFile(unrelated, "keep");
    await approveProfile(root);

    expect(await runProgrammaticScan(root)).toMatchObject({ ok: true });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });

  it("fails before persistence when retained history exceeds 1,000 records", () => {
    const records: ProgrammaticLifecycleRecordV1[] = Array.from(
      { length: PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT },
      (_, index) => {
        const item = opportunity(index.toString(16).padStart(64, "0"));
        return {
          version: 1,
          opportunity: item,
          lifecycle: { version: 1, opportunity: item.identity, state: "dismissed" },
          presence: "disappeared",
        };
      },
    );
    const full = programmaticLifecycleStateV1Schema.parse({
      version: 1,
      configurationFingerprint: fingerprint,
      records,
    });

    expect(() =>
      reconcileProgrammaticLifecycle(full, discovery(opportunity("f".repeat(64))), fingerprint, []),
    ).toThrow("record limit exceeded");
  });
});

describe("Scan summaries report new, unchanged, active, completed, dismissed, disappeared, failed, and unverified counts without noisy raw inventory.", () => {
  it("returns every deterministic summary count without opportunity bodies", async () => {
    const root = await createRepository();
    const first = await runProgrammaticScan(root);
    const encoded = JSON.stringify(first);

    expect(first).toMatchObject({
      ok: true,
      summary: {
        new: 1,
        unchanged: 0,
        active: 1,
        completed: 0,
        dismissed: 0,
        disappeared: 0,
        failed: 0,
        unverified: 0,
      },
    });
    expect(encoded).not.toContain("inventory");
    expect(encoded).not.toContain("opportunities");
  });

  it("reports a scan-level failure without changing state", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const result = await runProgrammaticScan(root, {
      inventoryOperations: {
        readFile: async () => {
          throw new Error("injected inventory failure");
        },
      },
    });

    expect(result).toMatchObject({ ok: false, changed: false, summary: { failed: 1 } });
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(before);
  });
});

describe("Targeted automated tests cover first scan, identical rescan, changed evidence, disappearance, reappearance, dismissal, completion, corrupt state, interrupted persistence, and deterministic ordering.", () => {
  it("sorts records and summaries deterministically regardless of discovery input construction", () => {
    const first = opportunity("a".repeat(64));
    const second = opportunity("b".repeat(64));
    const result = reconcileProgrammaticLifecycle(null, discovery(second, first), fingerprint, [
      second.identity.id,
    ]);

    expect(result.state.records.map(({ opportunity: item }) => item.identity.id)).toEqual([
      first.identity.id,
      second.identity.id,
    ]);
    expect(result.summary).toEqual({
      new: 2,
      unchanged: 0,
      active: 2,
      completed: 0,
      dismissed: 0,
      disappeared: 0,
      failed: 0,
      unverified: 1,
    });
  });
});
