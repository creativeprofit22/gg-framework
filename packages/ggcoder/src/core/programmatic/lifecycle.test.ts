import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProgrammaticChatResponse } from "@kenkaiiii/gg-core/programmatic-chat-contract";
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
  accessProgrammaticExecutionRecord,
  settleProgrammaticExecutionRecord,
  readProgrammaticChatReport,
  readProgrammaticChatDetail,
  dismissProgrammaticOpportunity,
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

describe("chat report and dismissal", () => {
  it("refuses a rescan while a stored opportunity is owned without changing its snapshot", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const state = await persistedState(root);
    const id = state.records[0]!.opportunity.identity.id;
    await accessProgrammaticExecutionRecord(root, id, state.configurationFingerprint, { from: "discovered", to: "queued" });
    await accessProgrammaticExecutionRecord(root, id, state.configurationFingerprint, { from: "queued", to: "running", runId: randomUUID() });
    const bytes = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    expect(await runProgrammaticScan(root)).toMatchObject({ ok: false, changed: false });
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(bytes);
  });
  it.each([1, 50])("blocks conflicting actions with an owner at index %i and restores them after settlement", async (ownerIndex) => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const initial = await persistedState(root);
    const first = initial.records[0]!;
    initial.records = Array.from({ length: 51 }, (_, index) => {
      const identity = { ...first.opportunity.identity, id: index.toString(16).padStart(64, "0") };
      return { ...first, opportunity: { ...first.opportunity, identity },
        lifecycle: { ...first.lifecycle, opportunity: identity } };
    });
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(initial));
    const id = initial.records[0]!.opportunity.identity.id;
    const owner = initial.records[ownerIndex]!.opportunity.identity.id;
    const fp = initial.configurationFingerprint;
    const runId = randomUUID();
    await accessProgrammaticExecutionRecord(root, owner, fp, { from: "discovered", to: "queued" });
    await accessProgrammaticExecutionRecord(root, owner, fp, { from: "queued", to: "running", runId });
    const report = await readProgrammaticChatReport(root);
    const detail = await readProgrammaticChatDetail(root, id);
    expect(report.rows).toHaveLength(50);
    expect(report.rows.some((row) => row.state === "running")).toBe(ownerIndex < 50);
    expect(report.scan).toMatchObject({ available: false, reason: expect.stringContaining("running") });
    expect(detail.detail?.summary).toEqual(report.rows[0]);
    expect(detail.detail?.summary).toMatchObject({
      state: "discovered", route: { available: true },
      actions: { run: { available: false, reason: expect.stringContaining("running") },
        dismiss: { available: false, reason: expect.stringContaining("running") } },
    });
    expect(detail.detail?.evidence.length).toBeGreaterThan(0);
    expect(isProgrammaticChatResponse({ version: 1, action: "report", ok: true, report })).toBe(true);
    expect(isProgrammaticChatResponse({ version: 1, action: "detail", ok: true, ...detail })).toBe(true);
    await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow("running");
    await expect(dismissProgrammaticOpportunity(root, id, report.snapshot!)).rejects.toThrow("running");
    await settleProgrammaticExecutionRecord(root, owner, runId, fp, "completed");
    const refreshed = await readProgrammaticChatReport(root);
    expect(refreshed.snapshot).not.toBe(report.snapshot);
    expect(refreshed.scan.available).toBe(true);
    expect(refreshed.rows[0]).toMatchObject({ actions: { run: { available: true }, dismiss: { available: true } } });
    expect((await readProgrammaticChatDetail(root, id)).detail?.summary).toEqual(refreshed.rows[0]);
  });
  it("allows an approved refresh scan without promoting last-known records on reads", async () => {
    const root = await createRepository();
    expect((await runProgrammaticScan(root)).ok).toBe(true);
    const initial = await readProgrammaticChatReport(root);
    const bytes = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const id = initial.rows[0]!.id;
    await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
    expect(await readProgrammaticChatReport(root)).toMatchObject({
      status: "stale", scan: { available: false },
    });
    expect(await runProgrammaticScan(root)).toMatchObject({ ok: false, error: "stale-configuration" });
    await approveProfile(root);
    const approved = await readProgrammaticChatReport(root);
    expect(approved).toMatchObject({
      status: "stale", scan: { available: true },
      snapshot: initial.snapshot, fingerprint: initial.fingerprint,
    });
    expect(approved.rows.every((row) => !row.route.available)).toBe(true);
    expect((await readProgrammaticChatDetail(root, id)).detail?.summary.route.available).toBe(false);
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(bytes);
    expect((await runProgrammaticScan(root)).ok).toBe(true);
    const refreshed = await readProgrammaticChatReport(root);
    expect(refreshed).toMatchObject({ status: "current", scan: { available: true } });
    expect(refreshed.fingerprint).not.toBe(initial.fingerprint);
    expect(refreshed.rows.map((row) => row.id)).toContain(id);
    expect((await readProgrammaticChatDetail(root, id)).detail?.summary.route.available).toBe(true);
  });
  it("hydrates without writes and returns one bounded detail", async () => {
    const root = await createRepository();
    expect((await runProgrammaticScan(root)).ok).toBe(true);
    const bytes = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const noWrites = {
      operations: {
        writeFile: async () => {
          throw new Error("Unexpected write");
        },
        rename: async () => {
          throw new Error("Unexpected rename");
        },
        rm: async () => {
          throw new Error("Unexpected removal");
        },
      },
    };
    const report = await readProgrammaticChatReport(root, 0, noWrites);
    expect(report.status).toBe("current");
    expect(isProgrammaticChatResponse({ version: 1, action: "report", ok: true, report })).toBe(
      true,
    );
    expect(report.rows.length).toBeGreaterThan(0);
    const selected = await readProgrammaticChatDetail(root, report.rows[0]!.id, noWrites);
    expect(
      isProgrammaticChatResponse({ version: 1, action: "detail", ok: true, ...selected }),
    ).toBe(true);
    expect(selected.snapshot).toBe(report.snapshot);
    expect(selected.detail?.summary).toEqual(report.rows[0]);
    expect(selected.detail?.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(selected)).not.toContain('"arguments"');
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(bytes);
  });
  it.each([
    { requested: 50, total: 1, offset: 0, count: 1 },
    { requested: 50, total: 0, offset: 0, count: 0 },
    { requested: 100, total: 51, offset: 50, count: 1 },
    { requested: 50, total: 50, offset: 0, count: 50 },
  ])("recovers a smaller previous report at $requested to $offset ($total records) without writes", async ({ requested, total, offset, count }) => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const initial = await persistedState(root);
    const first = initial.records[0]!;
    initial.records = Array.from({ length: 151 }, (_, index) => {
      const identity = { ...first.opportunity.identity, id: index.toString(16).padStart(64, "0") };
      return { ...first, opportunity: { ...first.opportunity, identity },
        lifecycle: { ...first.lifecycle, opportunity: identity } };
    });
    const primaryPath = path.join(root, PROGRAMMATIC_STATE_PATH);
    const previousPath = path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH);
    await writeFile(primaryPath, JSON.stringify(initial));
    const oldPage = await readProgrammaticChatReport(root, requested);
    expect(oldPage.offset).toBe(requested);
    expect(oldPage.rows).toHaveLength(50);
    const selectedId = oldPage.rows[0]!.id;
    const previousBytes = JSON.stringify({ ...initial, records: initial.records.slice(0, total) });
    await writeFile(previousPath, previousBytes);
    await writeFile(primaryPath, "broken");
    const report = await readProgrammaticChatReport(root, oldPage.offset);
    expect(report).toMatchObject({ status: "recovered", offset, total });
    expect(report.rows).toHaveLength(count);
    expect(report.rows.map((row) => row.id)).toEqual(
      initial.records.slice(offset, offset + count).map((record) => record.opportunity.identity.id),
    );
    expect(isProgrammaticChatResponse({ version: 1, action: "report", ok: true, report })).toBe(true);
    expect(await readProgrammaticChatReport(root, report.offset)).toEqual(report);
    expect((await readProgrammaticChatDetail(root, selectedId)).detail).toBeNull();
    expect(await readFile(primaryPath, "utf8")).toBe("broken");
    expect(await readFile(previousPath, "utf8")).toBe(previousBytes);
  });
  it("retains stale and recovered records without repairing storage", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const bytes = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const initial = await readProgrammaticChatReport(root);
    await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), bytes);
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "broken");
    const recovered = await readProgrammaticChatReport(root);
    expect(recovered.status).toBe("recovered");
    expect(recovered.rows.map((row) => row.id)).toEqual(initial.rows.map((row) => row.id));
    expect(recovered.rows.every((row) => !row.route.available)).toBe(true);
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")).toBe("broken");
    await writeFile(path.join(root, ".gg/programmatic/profile.json"), "invalid");
    const stale = await readProgrammaticChatReport(root);
    expect(stale.status).toBe("stale");
    expect(stale.rows.map((row) => row.id)).toEqual(initial.rows.map((row) => row.id));
    expect(stale.rows.every((row) => !row.route.available)).toBe(true);
  });
  it("dismisses only the selected record and acknowledges a repeated current dismissal", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await persistedState(root);
    const report = await readProgrammaticChatReport(root);
    const id = report.rows[0]!.id;
    expect(await dismissProgrammaticOpportunity(root, id, report.snapshot!)).toEqual({
      changed: true,
    });
    const after = await persistedState(root);
    expect(after.records.find((item) => item.opportunity.identity.id === id)?.lifecycle.state).toBe(
      "dismissed",
    );
    expect(after.records.filter((item) => item.opportunity.identity.id !== id)).toEqual(
      before.records.filter((item) => item.opportunity.identity.id !== id),
    );
    const current = await readProgrammaticChatReport(root);
    expect(await dismissProgrammaticOpportunity(root, id, current.snapshot!)).toEqual({
      changed: false,
    });
    await expect(dismissProgrammaticOpportunity(root, id, report.snapshot!)).rejects.toThrow(
      "Report changed",
    );
    expect(
      JSON.parse(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), "utf8")),
    ).toEqual(before);
  });
  it("rejects competing writes, owned runs and completed selections", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await persistedState(root);
    const report = await readProgrammaticChatReport(root);
    const id = report.rows[0]!.id;
    const running = {
      ...before,
      records: before.records.map((record, index) =>
        index === 0
          ? {
              ...record,
              lifecycle: { ...record.lifecycle, state: "running", runId: randomUUID() },
            }
          : record,
      ),
    };
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(running));
    await expect(dismissProgrammaticOpportunity(root, id, report.snapshot!)).rejects.toThrow(
      "Report changed",
    );
    const owned = await readProgrammaticChatReport(root);
    await expect(dismissProgrammaticOpportunity(root, id, owned.snapshot!)).rejects.toThrow(
      "running",
    );
    const completed = {
      ...before,
      records: before.records.map((record, index) =>
        index === 0
          ? {
              ...record,
              lifecycle: { ...record.lifecycle, state: "completed" },
            }
          : record,
      ),
    };
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(completed));
    const terminal = await readProgrammaticChatReport(root);
    await expect(dismissProgrammaticOpportunity(root, id, terminal.snapshot!)).rejects.toThrow();
  });
  it("rejects a writer racing the mutation callback and preserves its records", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const initial = await persistedState(root);
    const report = await readProgrammaticChatReport(root);
    const changed = { ...initial, configurationRefreshRequired: true };
    await expect(
      dismissProgrammaticOpportunity(root, report.rows[0]!.id, report.snapshot!, {
        onPreFileMutation: async () => {
          await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(changed));
        },
      }),
    ).rejects.toThrow("Lifecycle changed");
    expect(await persistedState(root)).toEqual(changed);
  });
  it("recovers dismissal without overwriting the valid previous report", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const initial = await persistedState(root);
    initial.records[0]!.opportunity.route = { status: "unroutable" };
    await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), JSON.stringify(initial));
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "broken");
    const report = await readProgrammaticChatReport(root);
    expect(report.rows[0]!.route.reason).toBe(
      "The opportunity has no allowlisted specialist candidate.",
    );
    expect(
      await dismissProgrammaticOpportunity(root, report.rows[0]!.id, report.snapshot!),
    ).toEqual({ changed: true });
    expect((await persistedState(root)).records[0]!.lifecycle.state).toBe("dismissed");
    expect(
      JSON.parse(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), "utf8")),
    ).toEqual(initial);
  });
  it("serializes competing dismissals without a lost update", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const report = await readProgrammaticChatReport(root);
    const results = await Promise.allSettled(
      [1, 2].map(() => dismissProgrammaticOpportunity(root, report.rows[0]!.id, report.snapshot!)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await persistedState(root)).records[0]!.lifecycle.state).toBe("dismissed");
  });
  it("paginates at fifty and retains disappeared detail", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const initial = await persistedState(root);
    const first = initial.records[0]!;
    initial.records = Array.from({ length: 51 }, (_, index) => {
      const identity = { ...first.opportunity.identity, id: index.toString(16).padStart(64, "0") };
      return {
        ...first,
        presence: "disappeared",
        opportunity: { ...first.opportunity, identity },
        lifecycle: { ...first.lifecycle, opportunity: identity },
      };
    });
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(initial));
    const page = await readProgrammaticChatReport(root);
    expect(page.rows).toHaveLength(50);
    expect(page.total).toBe(51);
    const tail = await readProgrammaticChatReport(root, 50);
    expect(tail.rows).toHaveLength(1);
    const selected = await readProgrammaticChatDetail(root, tail.rows[0]!.id);
    expect(selected.detail?.summary.presence).toBe("disappeared");
    expect(selected.detail?.summary.route.available).toBe(false);
    expect((await readProgrammaticChatDetail(root, "f".repeat(64))).detail).toBeNull();
  });
  it("retains valid data after failed atomic replacement", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    const report = await readProgrammaticChatReport(root);
    await expect(
      dismissProgrammaticOpportunity(root, report.rows[0]!.id, report.snapshot!, {
        operations: {
          rename: async () => {
            throw new Error("Disk failure");
          },
        },
      }),
    ).rejects.toThrow("Disk failure");
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(before);
  });
});

it("transitions one selected record, refuses overlap and preserves unrelated records", async () => {
  const root = await createRepository();
  await runProgrammaticScan(root);
  const initial = await persistedState(root);
  const selected = initial.records[0]!;
  const id = selected.opportunity.identity.id;
  const fp = initial.configurationFingerprint;
  const unrelated = initial.records.slice(1);
  const move = (
    from: "discovered" | "queued" | "running",
    to: "queued" | "running" | "completed",
  ) => accessProgrammaticExecutionRecord(root, id, fp, { from, to });
  await expect(move("discovered", "completed")).rejects.toThrow();
  await move("discovered", "queued");
  await move("queued", "running");
  await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow("running");
  await expect(move("queued", "running")).rejects.toThrow();
  await move("running", "queued");
  await move("queued", "running");
  await move("running", "completed");
  expect((await persistedState(root)).records.slice(1)).toEqual(unrelated);
  await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow("nonterminal");
});

it("recovers the previous valid execution state and refuses changed approved selections", async () => {
  const root = await createRepository();
  await runProgrammaticScan(root);
  const initial = await persistedState(root);
  const id = initial.records[0]!.opportunity.identity.id;
  const fp = initial.configurationFingerprint;
  const selected = await accessProgrammaticExecutionRecord(root, id, fp);
  await accessProgrammaticExecutionRecord(root, id, fp, { from: "discovered", to: "queued" });
  await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "broken primary");
  expect(await accessProgrammaticExecutionRecord(root, id, fp)).toMatchObject({
    lifecycle: { state: "discovered" },
  });
  await expect(
    accessProgrammaticExecutionRecord(root, id, fp, {
      from: "discovered",
      to: "queued",
      expectedProfileSha256: "f".repeat(64),
    }),
  ).rejects.toThrow("selection changed");
  await accessProgrammaticExecutionRecord(root, id, fp, {
    from: "discovered",
    to: "queued",
    expectedProfileSha256: selected.approvalSha256,
    expectedOpportunity: selected.opportunity,
  });
  expect((await persistedState(root)).records[0]!.lifecycle.state).toBe("queued");
});

it("does not replace primary state after a failed execution write", async () => {
  const root = await createRepository();
  await runProgrammaticScan(root);
  const initial = await persistedState(root);
  await expect(
    accessProgrammaticExecutionRecord(
      root,
      initial.records[0]!.opportunity.identity.id,
      initial.configurationFingerprint,
      { from: "discovered", to: "queued" },
      {
        operations: {
          rename: async () => {
            throw new Error("fixture rename failure");
          },
        },
      },
    ),
  ).rejects.toThrow("fixture rename failure");
  expect(await persistedState(root)).toEqual(initial);
});

async function startOwnedRun(root: string) {
  await runProgrammaticScan(root);
  const initial = await persistedState(root);
  const id = initial.records[0]!.opportunity.identity.id;
  const fp = initial.configurationFingerprint;
  const runId = randomUUID();
  await accessProgrammaticExecutionRecord(root, id, fp, { from: "discovered", to: "queued" });
  await accessProgrammaticExecutionRecord(root, id, fp, { from: "queued", to: "running", runId });
  return { id, fp, runId };
}

it("settles the old owner without replacing newer profile, opportunity evidence or unrelated records", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
  await approveProfile(root);
  expect((await runProgrammaticScan(root)).ok).toBe(false);
  // Model a newer externally stored snapshot; normal rescans now reject owned runs.
  const inspection = await buildProgrammaticProfileProposal(root);
  const current = await persistedState(root);
  current.configurationFingerprint = inspection.configurationFingerprint;
  expect(current.configurationFingerprint).not.toEqual(fp);
  current.records[0]!.opportunity.currentProcess = "Newer opportunity evidence";
  current.records[0]!.presence = "disappeared";
  const unrelated = opportunity("f".repeat(64));
  current.records.push({
    version: 1,
    opportunity: unrelated,
    lifecycle: { version: 1, opportunity: unrelated.identity, state: "dismissed" },
    presence: "present",
  });
  await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(current));
  const profilePath = path.join(root, ".gg/programmatic/profile.json");
  const profileBytes = await readFile(profilePath);
  await settleProgrammaticExecutionRecord(root, id, runId, fp, "completed");
  const settled = await persistedState(root);
  expect(settled).toEqual({
    ...current,
    configurationRefreshRequired: true,
    records: current.records.map((record) =>
      record.opportunity.identity.id === id
        ? {
            ...record,
            lifecycle: {
              version: 1,
              opportunity: record.lifecycle.opportunity,
              state: "completed",
            },
          }
        : record,
    ),
  });
  expect(await readFile(profilePath)).toEqual(profileBytes);
  await expect(
    accessProgrammaticExecutionRecord(
      root,
      unrelated.identity.id,
      current.configurationFingerprint,
    ),
  ).rejects.toThrow("Refresh inventory");
});

it("does not treat unrelated external configuration drift as approval", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":false}}');
  expect(await settleProgrammaticExecutionRecord(root, id, runId, fp, "queued")).toEqual({
    configurationRefreshRequired: true,
  });
  expect((await persistedState(root)).configurationFingerprint).toEqual(fp);
  await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow(
    "configuration changed",
  );
  expect(await runProgrammaticScan(root)).toMatchObject({
    ok: false,
    error: "stale-configuration",
  });
});

it.each(["profile", "state", "owner"])(
  "preserves concurrent %s changes at settlement commit",
  async (kind) => {
    const root = await createRepository();
    const { id, fp, runId } = await startOwnedRun(root);
    let changed: ProgrammaticLifecycleStateV1 | undefined;
    let injected = false;
    const profilePath = path.join(root, ".gg/programmatic/profile.json");
    const changedProfile = JSON.stringify({
      version: 1,
      configurationFingerprint: fp,
      profile: { version: 1, scanners: [] },
    });
    const settlement = settleProgrammaticExecutionRecord(root, id, runId, fp, "queued", {
      onPreFileMutation: async (file) => {
        if (file !== PROGRAMMATIC_STATE_PATH || injected) return;
        injected = true;
        if (kind === "profile") {
          await writeFile(profilePath, changedProfile);
          return;
        }
        changed = await persistedState(root);
        if (kind === "owner") changed.records[0]!.lifecycle.runId = randomUUID();
        else {
          const unrelated = opportunity("f".repeat(64));
          changed.records.push({
            version: 1,
            opportunity: unrelated,
            lifecycle: { version: 1, opportunity: unrelated.identity, state: "discovered" },
            presence: "present",
          });
        }
        await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(changed));
      },
    });
    if (kind === "profile") {
      await expect(settlement).resolves.toEqual({ configurationRefreshRequired: false });
      expect(await readFile(profilePath, "utf8")).toBe(changedProfile);
      await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow("not approved");
    } else if (kind === "state") {
      await expect(settlement).resolves.toEqual({ configurationRefreshRequired: false });
      const settled = await persistedState(root);
      expect(settled.records[0]!.lifecycle.state).toBe("queued");
      expect(settled.records.at(-1)).toEqual(changed!.records.at(-1));
    } else {
      await expect(settlement).rejects.toThrow("ownership changed");
      expect(await persistedState(root)).toEqual(changed);
      await expect(
        settleProgrammaticExecutionRecord(root, id, runId, fp, "queued"),
      ).rejects.toThrow("ownership changed");
    }
  },
);

it("bounds persistent state contention without overwriting it or releasing ownership", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  let mutations = 0;
  let latest = await persistedState(root);
  await expect(
    settleProgrammaticExecutionRecord(root, id, runId, fp, "completed", {
      onPreFileMutation: async (file) => {
        if (file !== PROGRAMMATIC_STATE_PATH) return;
        latest = await persistedState(root);
        latest.records[0]!.opportunity.currentProcess = `Concurrent evidence ${++mutations}`;
        await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(latest));
      },
    }),
  ).rejects.toThrow("state changed during settlement");
  expect(mutations).toBe(3);
  expect(await persistedState(root)).toEqual(latest);
  expect(latest.records[0]!.lifecycle).toMatchObject({ state: "running", runId });
});

it("requires owner settlement and rejects replay against a subsequent run", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  await expect(
    accessProgrammaticExecutionRecord(root, id, fp, { from: "running", to: "queued" }),
  ).rejects.toThrow("owner settlement");
  await expect(
    settleProgrammaticExecutionRecord(root, id, randomUUID(), fp, "completed"),
  ).rejects.toThrow("ownership changed");
  await settleProgrammaticExecutionRecord(root, id, runId, fp, "queued");
  const newRunId = randomUUID();
  await accessProgrammaticExecutionRecord(root, id, fp, {
    from: "queued",
    to: "running",
    runId: newRunId,
  });
  await expect(settleProgrammaticExecutionRecord(root, id, runId, fp, "completed")).rejects.toThrow(
    "ownership changed",
  );
  expect((await persistedState(root)).records[0]!.lifecycle).toMatchObject({
    state: "running",
    runId: newRunId,
  });
});

it("settles with a refresh gate when inventory is unreadable and retains ownership on persistence failure", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  const before = await persistedState(root);
  await expect(
    settleProgrammaticExecutionRecord(root, id, runId, fp, "queued", {
      operations: {
        rename: async () => {
          throw new Error("fixture rename failure");
        },
      },
    }),
  ).rejects.toThrow("fixture rename failure");
  expect(await persistedState(root)).toEqual(before);
  await settleProgrammaticExecutionRecord(root, id, runId, fp, "queued", {
    inventoryOperations: {
      readFile: async () => {
        throw new Error("fixture unreadable inventory");
      },
    },
  });
  expect((await persistedState(root)).configurationRefreshRequired).toBe(true);
  await expect(accessProgrammaticExecutionRecord(root, id, fp)).rejects.toThrow(
    "Refresh inventory",
  );
  expect((await runProgrammaticScan(root)).ok).toBe(true);
  expect((await persistedState(root)).configurationRefreshRequired).toBeUndefined();
  expect(await accessProgrammaticExecutionRecord(root, id, fp)).toMatchObject({
    lifecycle: { state: "queued" },
  });
});

it("recovers an owned running backup, but never a backup belonging to another run", async () => {
  const root = await createRepository();
  const { id, fp, runId } = await startOwnedRun(root);
  const running = await persistedState(root);
  await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), JSON.stringify(running));
  await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "broken primary");
  await expect(
    settleProgrammaticExecutionRecord(root, id, randomUUID(), fp, "queued"),
  ).rejects.toThrow("ownership changed");
  await settleProgrammaticExecutionRecord(root, id, runId, fp, "queued");
  expect((await persistedState(root)).records[0]!.lifecycle.state).toBe("queued");
});

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
  it("reports committed state when the primary mutation notification fails", async () => {
    const root = await createRepository();
    const result = await runProgrammaticScan(root, {
      onFileMutated: (file) => {
        if (file === PROGRAMMATIC_STATE_PATH) throw new Error("injected notification failure");
      },
    });

    const state = await persistedState(root);
    expect(state.records).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false, changed: true, recovered: false, error: "post-commit-failed",
      configurationFingerprint: state.configurationFingerprint,
      summary: { new: 1, active: 1, failed: 1 },
      detail: expect.stringContaining("persisted"),
    });
  });

  it.each([
    { failure: "notification", recovered: false },
    { failure: "cleanup", recovered: false },
    { failure: "both", recovered: false },
    { failure: "notification", recovered: true },
    { failure: "cleanup", recovered: true },
  ])("retains records and recovery after committed $failure failure (recovered=$recovered)", async ({ failure, recovered }) => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await persistedState(root);
    before.records[0]!.lifecycle.state = "dismissed";
    const historical = opportunity("f".repeat(64));
    const unaffected: ProgrammaticLifecycleRecordV1 = {
      version: 1, opportunity: historical,
      lifecycle: { version: 1, opportunity: historical.identity, state: "completed" },
      presence: "disappeared",
    };
    before.records.push(unaffected);
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), JSON.stringify(before));
    if (recovered) {
      await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), JSON.stringify(before));
      await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "{broken");
    }
    await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
    await approveProfile(root);
    let notified = false;
    let cleanupFailed = false;
    const result = await runProgrammaticScan(root, {
      onFileMutated: (file) => {
        if (file !== PROGRAMMATIC_STATE_PATH) return;
        notified = true;
        if (failure !== "cleanup") throw new Error("injected notification failure");
      },
      operations: {
        rm: async (file, options) => {
          if (notified && file.endsWith(`${path.sep}.state.tmp`) && failure !== "notification") {
            cleanupFailed = true;
            throw new Error("injected cleanup failure");
          }
          return rm(file, options);
        },
      },
    });
    const committed = await persistedState(root);
    expect(notified).toBe(true);
    expect(cleanupFailed).toBe(failure !== "notification");
    expect(committed.configurationFingerprint).not.toEqual(before.configurationFingerprint);
    expect(committed.records).toHaveLength(2);
    expect(committed.records).toContainEqual(unaffected);
    expect(committed.records.find((record) => record.opportunity.identity.id === before.records[0]!.opportunity.identity.id)?.lifecycle).toEqual(before.records[0]!.lifecycle);
    expect(result).toMatchObject({
      ok: false, changed: true, recovered, error: "post-commit-failed",
      configurationFingerprint: committed.configurationFingerprint,
      summary: { dismissed: 1, disappeared: 1, failed: 1 },
    });
    expect(programmaticLifecycleStateV1Schema.parse(JSON.parse(
      await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH), "utf8"),
    ))).toEqual(before);
    await writeFile(path.join(root, PROGRAMMATIC_STATE_PATH), "{interrupted");
    expect(await readProgrammaticChatReport(root)).toMatchObject({
      status: "stale", total: 2, fingerprint: before.configurationFingerprint.sha256,
    });
    expect(await runProgrammaticScan(root)).toMatchObject({ ok: true, recovered: true });
    expect((await persistedState(root)).records).toEqual(committed.records);
  });

  it.each([PROGRAMMATIC_STATE_PATH, PROGRAMMATIC_PREVIOUS_STATE_PATH])(
    "does not claim a primary commit when the pre-mutation hook fails for %s",
    async (failurePath) => {
      const root = await createRepository();
      await runProgrammaticScan(root);
      const primaryPath = path.join(root, PROGRAMMATIC_STATE_PATH);
      const before = await readFile(primaryPath);
      await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
      await approveProfile(root);
      let failed = false;
      const result = await runProgrammaticScan(root, {
        onPreFileMutation: (file) => {
          if (file === failurePath) {
            failed = true;
            throw new Error("injected pre-mutation failure");
          }
        },
      });
      expect(failed).toBe(true);
      expect(result).toMatchObject({ ok: false, changed: false, error: "persistence-failed" });
      expect(await readFile(primaryPath)).toEqual(before);
    },
  );

  it("does not mistake a previous-state notification failure for a primary commit", async () => {
    const root = await createRepository();
    await runProgrammaticScan(root);
    const before = await readFile(path.join(root, PROGRAMMATIC_STATE_PATH));
    await writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
    await approveProfile(root);
    const result = await runProgrammaticScan(root, {
      onFileMutated: (file) => {
        if (file === PROGRAMMATIC_PREVIOUS_STATE_PATH) throw new Error("backup notification failed");
      },
    });
    expect(result).toMatchObject({ ok: false, changed: false, error: "persistence-failed" });
    expect(await readFile(path.join(root, PROGRAMMATIC_STATE_PATH))).toEqual(before);
    expect(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH))).toEqual(before);
  });

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
                rename: async (from, to) => {
                  if (from.endsWith(stateTemporary)) throw new Error("injected rename failure");
                  return rename(from, to);
                },
              }
            : {}),
        },
      });

      expect(result).toMatchObject({ ok: false, error: "persistence-failed", changed: false });
      expect(await readFile(primaryPath)).toEqual(before);
      expect(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_STATE_PATH))).toEqual(before);
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

  it("marks a configured specialist mismatch unverified after current route resolution", async () => {
    const root = await createRepository();
    const profilePath = path.join(root, ".gg/programmatic/profile.json");
    const envelope = JSON.parse(await readFile(profilePath, "utf8")) as {
      profile: { scanners: Array<{ specialistCommand: string }> };
    };
    envelope.profile.scanners[0]!.specialistCommand = "research";
    await writeFile(profilePath, JSON.stringify(envelope));

    await expect(runProgrammaticScan(root)).resolves.toMatchObject({
      ok: true,
      summary: { new: 1, unverified: 1 },
    });
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
