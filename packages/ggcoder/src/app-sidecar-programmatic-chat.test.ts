import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  PROGRAMMATIC_STATE_PATH, accessProgrammaticExecutionRecord, settleProgrammaticExecutionRecord,
  runProgrammaticScan, readProgrammaticChatReport, readProgrammaticChatDetail,
  dismissProgrammaticOpportunity,
} from "./core/programmatic/lifecycle.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./core/programmatic/profile.js";
import { programmaticLifecycleStateV1Schema } from "./core/programmatic/contracts.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunClaim } from "./core/run-claim.js";
import { createStrandedQueueDrain } from "./app-sidecar-user-turn.js";
import {
  AppSidecarProgrammaticChat,
  type ProgrammaticChatTarget,
} from "./app-sidecar-programmatic-chat.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-chat-adapter-"));
  roots.push(cwd);
  await mkdir(path.join(cwd, "src-tauri"));
  await writeFile(path.join(cwd, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(cwd, "src-tauri/tauri.conf.json"), "{}\n");
  await writeFile(path.join(cwd, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  const target: ProgrammaticChatTarget = {
    cwd,
    identity: "one",
    codeMode: true,
    planMode: false,
    busy: false,
  };
  let claimed = false;
  const adapter = new AppSidecarProgrammaticChat(
    () => target,
    () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    () => {
      claimed = false;
    },
  );
  const call = (action: string, fields = {}) => adapter.handle({ version: 1, action, ...fields });
  const inspect = async () => {
    const result = await call("inspect-setup");
    if (!("ok" in result.body) || !result.body.ok || result.body.action !== "inspect-setup")
      throw new Error(JSON.stringify(result));
    return result.body.proposal;
  };
  return { cwd, target, adapter, call, inspect };
}
describe("session-scoped programmatic adapter", () => {
  it("project-agnostic discovery returns an assessment separately from the desktop Check scanner result", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-check-discovery-"));
    roots.push(cwd);
    await writeFile(path.join(cwd, "WORKFLOW"), "Weekly dispatch needs paper-ledger reconciliation.\n");
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect(proposal.profile.scanners).toEqual([]);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    const priorProfile = await readFile(profilePath);
    const claim = new RunClaim();
    let scans = 0;
    let settlements = 0;
    const adapter = new AppSidecarProgrammaticChat(
      () => ({ cwd, identity: "discovery", codeMode: true, planMode: false, busy: claim.active }),
      () => claim.claim(), () => claim.release(),
      {
        inspect: buildProgrammaticProfileProposal, persist: persistProgrammaticProfile,
        report: readProgrammaticChatReport, detail: readProgrammaticChatDetail, dismiss: dismissProgrammaticOpportunity,
        scan: async (...args) => { scans++; return runProgrammaticScan(...args); },
      },
      () => { settlements++; },
    );
    try {
      // This is the existing Check for opportunities request, not a direct scanner test.
      const result = await adapter.handle({ version: 1, action: "scan" });
      expect(result.status).toBe(200);
      expect(scans).toBe(1);
      expect(claim.active).toBe(false);
      expect(settlements).toBe(1);
      expect(await readFile(profilePath)).toEqual(priorProfile);
      await expect(access(path.join(cwd, ".gg/commands"))).rejects.toThrow();
      // This adapter fixture has no provider owner: scanner success must not imply
      // completed needs assessment. A host-only result must explicitly say unavailable.
      expect(result.body).toMatchObject({ ok: true, action: "scan", assessment: {
        mode: "configured", status: "unavailable",
        deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 },
        coverage: [{ scope: "project", status: "uninspected" }],
        observations: [],
      } });
    } finally { adapter.dispose(); }
  });
  it.each([false, true])("drains a prompt queued during report I/O after releasing its claim (failure=%s)", async (fail) => {
    const f = await fixture();
    const claim = new RunClaim();
    const queued: string[] = [];
    const delivered: string[] = [];
    let unblock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let drainRun: Promise<void> | undefined;
    const drain = createStrandedQueueDrain(() => false, async () => {
      expect(claim.active).toBe(false);
      delivered.push(...queued.splice(0));
    });
    let settlements = 0;
    const adapter = new AppSidecarProgrammaticChat(
      () => ({ ...f.target, busy: claim.active }),
      () => claim.claim(),
      () => claim.release(),
      {
        inspect: buildProgrammaticProfileProposal, persist: persistProgrammaticProfile,
        report: async (...args) => {
          entered();
          await gate;
          if (fail) throw new Error("fixture report read failed");
          return readProgrammaticChatReport(...args);
        },
        detail: readProgrammaticChatDetail, dismiss: dismissProgrammaticOpportunity, scan: runProgrammaticScan,
      },
      () => { settlements++; drainRun = drain(); },
    );
    const request = adapter.handle({ version: 1, action: "report", offset: 0 });
    await started;
    expect(claim.active).toBe(true);
    queued.push("Create the reviewed command");
    expect((await adapter.handle({ version: 1, action: "report", offset: 0 })).status).toBe(409);
    expect(settlements).toBe(0);
    expect(delivered).toEqual([]);
    unblock();
    expect((await request).status).toBe(fail ? 409 : 200);
    await drainRun;
    expect(settlements).toBe(1);
    expect(claim.active).toBe(false);
    expect(queued).toEqual([]);
    expect(delivered).toEqual(["Create the reviewed command"]);
  });
  it("exposes exact drift read-only, gates current setup and preserves dismissed history through separately approved refresh", async () => {
    const f = await fixture();
    const initial = await f.inspect();
    expect(initial.operation).toBe("initial");
    expect((await f.call("approve-setup", { proposalHandle: initial.handle })).status).toBe(200);
    expect((await f.inspect()).handle).toBeNull();
    expect((await f.call("approve-setup", { proposalHandle: initial.handle })).status).toBe(409);
    await f.call("scan");
    const report = await readProgrammaticChatReport(f.cwd);
    const id = report.rows[0]!.id;
    await f.call("dismiss", { id, snapshot: report.snapshot });
    const statePath = path.join(f.cwd, PROGRAMMATIC_STATE_PATH);
    const before = await readFile(statePath);
    const profilePath = path.join(f.cwd, ".gg/programmatic/profile.json");
    const oldProfile = await readFile(profilePath);
    await writeFile(path.join(f.cwd, "package.json"), '{"name":"changed"}\n');
    expect((await f.call("report", { offset: 0 })).body).toMatchObject({ ok: true, report: {
      status: "stale", scan: { available: false }, configuration: { status: "refresh-required",
        drift: { files: [{ path: "package.json", kind: "modified" }] } },
    } });
    expect((await f.call("detail", { id })).body).toMatchObject({ ok: true, detail: { summary: { state: "dismissed" } } });
    expect(await readFile(profilePath)).toEqual(oldProfile);
    const refresh = await f.inspect();
    expect(refresh.operation).toBe("refresh");
    expect(refresh.handle).not.toBeNull();
    expect(await readFile(profilePath)).toEqual(oldProfile);
    expect((await f.call("approve-setup", { proposalHandle: refresh.handle })).status).toBe(200);
    expect(await readFile(statePath)).toEqual(before);
    expect((await f.call("scan")).status).toBe(200);
    expect((await readProgrammaticChatReport(f.cwd)).rows[0]).toMatchObject({ id, state: "dismissed" });
  });
  it("projects another pane's off-page owner and restores eligibility on fresh reads", async () => {
    const f = await fixture();
    const proposal = await f.inspect();
    await f.call("approve-setup", { proposalHandle: proposal.handle });
    await f.call("scan");
    const statePath = path.join(f.cwd, PROGRAMMATIC_STATE_PATH);
    const state = programmaticLifecycleStateV1Schema.parse(JSON.parse(await readFile(statePath, "utf8")));
    const first = state.records[0]!;
    state.records = Array.from({ length: 51 }, (_, index) => {
      const identity = { ...first.opportunity.identity, id: index.toString(16).padStart(64, "0") };
      return { ...first, opportunity: { ...first.opportunity, identity }, lifecycle: { ...first.lifecycle, opportunity: identity } };
    });
    await writeFile(statePath, JSON.stringify(state));
    const owner = state.records[50]!.opportunity.identity.id;
    const id = state.records[0]!.opportunity.identity.id;
    const fp = state.configurationFingerprint;
    const runId = randomUUID();
    await accessProgrammaticExecutionRecord(f.cwd, owner, fp, { from: "discovered", to: "queued" });
    await accessProgrammaticExecutionRecord(f.cwd, owner, fp, { from: "queued", to: "running", runId });
    const result = await f.call("report", { offset: 0 });
    if (!("ok" in result.body) || !result.body.ok || result.body.action !== "report") throw new Error("Missing report");
    expect(f.target.busy).toBe(false);
    expect(result.body.report.rows).toHaveLength(50);
    expect(result.body.report.rows.some((row) => row.state === "running")).toBe(false);
    expect(result.body.report.scan.available).toBe(false);
    expect((await f.call("detail", { id })).body).toMatchObject({ ok: true, detail: { summary: {
      route: { available: true }, actions: { run: { available: false }, dismiss: { available: false } },
    } } });
    expect((await f.call("inspect-setup")).status).toBe(200);
    expect((await f.call("scan")).status).toBe(409);
    expect((await f.call("dismiss", { id, snapshot: result.body.report.snapshot })).status).toBe(409);
    await settleProgrammaticExecutionRecord(f.cwd, owner, runId, fp, "completed");
    expect((await f.call("report", { offset: 0 })).body).toMatchObject({ ok: true, report: { scan: { available: true } } });
    expect((await f.call("detail", { id })).body).toMatchObject({ ok: true, detail: { summary: {
      actions: { run: { available: true }, dismiss: { available: true } },
    } } });
  });
  it("reconciles committed scan failures through read-only reports without retrying", async () => {
    const f = await fixture();
    const proposal = await f.inspect();
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(200);
    let scans = 0;
    const adapter = new AppSidecarProgrammaticChat(
      () => f.target, () => true, () => {},
      {
        inspect: buildProgrammaticProfileProposal,
        persist: persistProgrammaticProfile,
        report: readProgrammaticChatReport,
        detail: readProgrammaticChatDetail,
        dismiss: dismissProgrammaticOpportunity,
        scan: async (root) => {
          scans++;
          return runProgrammaticScan(root, {
            onFileMutated: (file) => {
              if (file === PROGRAMMATIC_STATE_PATH) throw new Error("notification failed");
            },
          });
        },
      },
    );
    expect(await adapter.handle({ version: 1, action: "scan" })).toMatchObject({
      status: 409,
      body: { ok: false, reconcile: true, error: expect.stringContaining("persisted") },
    });
    const primaryPath = path.join(f.cwd, PROGRAMMATIC_STATE_PATH);
    const committed = await readFile(primaryPath);
    const state = programmaticLifecycleStateV1Schema.parse(JSON.parse(committed.toString("utf8")));
    expect(state.records).toHaveLength(1);
    const report = await adapter.handle({ version: 1, action: "report", offset: 0 });
    expect(report).toMatchObject({ status: 200, body: { ok: true, report: {
      status: "current", rows: [{ id: state.records[0]!.opportunity.identity.id }],
    } } });
    expect(await readFile(primaryPath)).toEqual(committed);
    expect(scans).toBe(1);
  });

  it.each([false, true])("reconciles committed setup cleanup failure without retry or scan (thrown: %s)", async (throwAfterCommit) => {
    const f = await fixture();
    let writes = 0;
    let scans = 0;
    const adapter = new AppSidecarProgrammaticChat(
      () => f.target, () => true, () => {},
      {
        inspect: buildProgrammaticProfileProposal,
        persist: async (root, fingerprint, profile, options) => {
          writes++;
          const result = await persistProgrammaticProfile(root, fingerprint, profile, {
            ...options,
            operations: { rm: async () => { throw new Error("cleanup failed"); } },
          });
          if (throwAfterCommit) throw new Error("submitted write response lost");
          return result;
        },
        report: readProgrammaticChatReport,
        detail: readProgrammaticChatDetail,
        dismiss: dismissProgrammaticOpportunity,
        scan: async (root) => { scans++; return runProgrammaticScan(root); },
      },
    );
    const inspected = await adapter.handle({ version: 1, action: "inspect-setup" });
    if (!("ok" in inspected.body) || !inspected.body.ok || inspected.body.action !== "inspect-setup")
      throw new Error("Missing proposal");
    const proposalHandle = inspected.body.proposal.handle;
    expect(await adapter.handle({ version: 1, action: "approve-setup", proposalHandle }))
      .toMatchObject({ status: 409, body: { ok: false, reconcile: true } });
    const profilePath = path.join(f.cwd, ".gg/programmatic/profile.json");
    const committed = await readFile(profilePath);
    expect(await adapter.handle({ version: 1, action: "report", offset: 0 }))
      .toMatchObject({ status: 200, body: { ok: true, report: { configuration: { status: "current" } } } });
    expect(await adapter.handle({ version: 1, action: "approve-setup", proposalHandle }))
      .toMatchObject({ status: 409 });
    expect(await readFile(profilePath)).toEqual(committed);
    await expect(access(path.join(f.cwd, PROGRAMMATIC_STATE_PATH))).rejects.toThrow();
    expect(writes).toBe(1);
    expect(scans).toBe(0);
  });

  it("separates real inspection, explicit approval, scan and dismissal", async () => {
    const f = await fixture();
    expect((await f.call("report", { offset: 0 })).body).toMatchObject({ ok: true, report: { status: "setup-required", rows: [] } });
    const proposal = await f.inspect();
    await expect(access(path.join(f.cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(200);
    expect((await f.call("scan")).status).toBe(200);
    const report = await f.call("report", { offset: 0 });
    if (!("ok" in report.body) || !report.body.ok || report.body.action !== "report")
      throw new Error("Missing report");
    const row = report.body.report.rows[0]!;
    expect((await f.call("detail", { id: row.id })).status).toBe(200);
    expect(
      (await f.call("dismiss", { id: row.id, snapshot: report.body.report.snapshot })).status,
    ).toBe(200);
  });
  it("projects approved refresh availability through explicit actions and retains selected detail", async () => {
    const f = await fixture();
    const approve = async () => {
      const proposal = await f.inspect();
      expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(200);
    };
    const report = async () => {
      const result = await f.call("report", { offset: 0 });
      if (!("ok" in result.body) || !result.body.ok || result.body.action !== "report")
        throw new Error("Missing report");
      return result.body.report;
    };
    expect((await report()).scan.available).toBe(false);
    await approve();
    expect((await f.call("scan")).status).toBe(200);
    const initial = await report();
    const id = initial.rows[0]!.id;
    await writeFile(path.join(f.cwd, "package.json"), '{"name":"changed"}\n');
    expect(await report()).toMatchObject({ status: "stale", scan: { available: false } });
    expect((await f.call("scan")).status).toBe(409);
    await approve();
    const approved = await report();
    expect(approved).toMatchObject({ status: "stale", scan: { available: true }, snapshot: initial.snapshot });
    expect(approved.rows.every((row) => !row.route.available)).toBe(true);
    expect((await f.call("detail", { id })).body).toMatchObject({
      ok: true, detail: { summary: { id, route: { available: false } } },
    });
    expect((await f.call("scan")).status).toBe(200);
    expect(await report()).toMatchObject({ status: "current", scan: { available: true } });
    expect((await f.call("detail", { id })).body).toMatchObject({
      ok: true, detail: { summary: { id, route: { available: true } } },
    });
  });
  it("rejects Plan-mode setup review before claiming work or calling the provider", async () => {
    const f = await fixture();
    f.target.planMode = true;
    const claim = vi.fn(() => true);
    const assess = vi.fn<NonNullable<ConstructorParameters<typeof AppSidecarProgrammaticChat>[5]>>();
    const adapter = new AppSidecarProgrammaticChat(
      () => f.target, claim, () => {}, undefined, undefined, assess,
    );
    expect((await adapter.handle({ version: 1, action: "inspect-setup" })).status).toBe(403);
    expect(claim).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
  });
  it("rejects extra inputs, chat, busy, plan writes, missing and replaced approval handles", async () => {
    const f = await fixture();
    expect((await f.call("scan", { command: "shell" })).status).toBe(400);
    f.target.codeMode = false;
    expect((await f.call("report", { offset: 0 })).status).toBe(403);
    f.target.codeMode = true;
    f.target.busy = true;
    expect((await f.call("scan")).status).toBe(409);
    f.target.busy = false;
    const old = await f.inspect();
    f.target.planMode = true;
    expect((await f.call("scan")).status).toBe(403);
    expect((await f.call("inspect-setup")).status).toBe(403);
    expect((await f.call("report", { offset: 0 })).status).toBe(200);
    expect((await f.call("detail", { id: "a".repeat(64) })).status).toBe(200);
    expect((await f.call("approve-setup", { proposalHandle: old.handle })).status).toBe(403);
    f.target.planMode = false;
    const fresh = await f.inspect();
    expect(fresh.handle).not.toBe(old.handle);
    expect((await f.call("approve-setup", { proposalHandle: old.handle })).status).toBe(409);
    expect((await f.call("approve-setup", { proposalHandle: fresh.handle })).status).toBe(409);
  });
  it.each(["busy", "planMode"] as const)("preserves the exact handle on pre-consumption %s rejection", async (lock) => {
    const f = await fixture();
    const proposal = await f.inspect();
    f.target[lock] = true;
    const rejected = await f.call("approve-setup", { proposalHandle: proposal.handle });
    expect(rejected.body).toMatchObject({ ok: false, reconcile: false, approvableProposalHandle: proposal.handle });
    f.target[lock] = false;
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(200);
  });
  it("invalidates proposals on reset, disposal and target changes", async () => {
    const f = await fixture();
    let proposal = await f.inspect();
    f.adapter.reset();
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(409);
    proposal = await f.inspect();
    f.target.identity = "two";
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(409);
    proposal = await f.inspect();
    f.adapter.dispose();
    expect((await f.call("approve-setup", { proposalHandle: proposal.handle })).status).toBe(403);
  });
  it("rejects drift at real persistence and never reconstructs approval", async () => {
    const f = await fixture();
    const proposal = await f.inspect();
    await writeFile(path.join(f.cwd, "package.json"), '{"name":"changed"}');
    const stale = await f.call("approve-setup", { proposalHandle: proposal.handle });
    expect(stale).toMatchObject({ status: 409, body: { ok: false, reconcile: true } });
    expect(stale.body).not.toHaveProperty("approvableProposalHandle");
    await expect(access(path.join(f.cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
    expect((await f.call("report", { offset: 0 })).status).toBe(200);
    const consumed = await f.call("approve-setup", { proposalHandle: proposal.handle });
    expect(consumed.status).toBe(409);
    expect(consumed.body).not.toHaveProperty("approvableProposalHandle");
    const fresh = await f.inspect();
    expect(fresh.handle).not.toBe(proposal.handle);
    expect(fresh.fingerprint).not.toBe(proposal.fingerprint);
    expect((await f.call("approve-setup", { proposalHandle: fresh.handle })).status).toBe(200);
  });
  it("rejects overlapping operations and reports uncertain writes without auto retry", async () => {
    const f = await fixture();
    const proposal = await f.inspect();
    const operations = await Promise.all([
      f.call("approve-setup", { proposalHandle: proposal.handle }),
      f.call("scan"),
    ]);
    expect(operations.map((result) => result.status)).toEqual([200, 409]);
    const failed = await f.call("dismiss", { id: "a".repeat(64), snapshot: "b".repeat(64) });
    expect(failed.body).toMatchObject({ ok: false, reconcile: true });
    expect((await f.call("report", { offset: 0 })).status).toBe(200);
  });
});
