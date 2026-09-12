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
import { afterEach, describe, expect, it } from "vitest";
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
  it("rejects extra inputs, chat, busy, plan writes, missing and replaced approval handles", async () => {
    const f = await fixture();
    expect((await f.call("scan", { command: "shell" })).status).toBe(400);
    f.target.codeMode = false;
    expect((await f.call("report", { offset: 0 })).status).toBe(403);
    f.target.codeMode = true;
    f.target.busy = true;
    expect((await f.call("scan")).status).toBe(409);
    f.target.busy = false;
    f.target.planMode = true;
    expect((await f.call("scan")).status).toBe(403);
    const old = await f.inspect();
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
    expect(stale).toMatchObject({ status: 409, body: { ok: false, reconcile: false } });
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
