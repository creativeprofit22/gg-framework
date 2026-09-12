import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalProjectKey,
  validateNotesDocumentV3,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  PhaseBindingRequest,
  PhaseExecutionReconciliationRequestV3,
  PhaseLeaseRequestV2,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  createAppSidecarPhaseBindingService,
  type PhaseBindingSession,
} from "./app-sidecar-phase-binding.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import {
  PHASE_LEASE_TTL_MS,
  RoadmapPhaseLeaseRepository,
} from "./roadmap-phase-lease-repository.js";
import type { RoadmapPhaseLeaseMarkerV1 } from "./phase-context.js";
import { AppSidecarRoadmapToolHost } from "./app-sidecar-roadmap-tool-host.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const roots: string[] = [];
const sessionA = { sessionId: "session-a", sessionPath: "/sessions/a.jsonl" };
const sessionB = { sessionId: "session-b", sessionPath: "/sessions/b.jsonl" };
const sessionC = { sessionId: "session-c", sessionPath: "/sessions/c.jsonl" };

class FakeSession implements PhaseBindingSession {
  active: ActivePhaseContextV1 | undefined;
  readonly setCalls: Array<ActivePhaseContextV1 | undefined> = [];
  readonly clearReasons: string[] = [];
  leaseMarker: RoadmapPhaseLeaseMarkerV1 | undefined;

  constructor(
    readonly cwd: string,
    private readonly state: { sessionId: string; sessionPath: string | null },
  ) {}

  getState() {
    return { cwd: this.cwd, ...this.state };
  }

  getActivePhaseContext() {
    return this.active;
  }

  async setActivePhaseContext(context: ActivePhaseContextV1 | undefined) {
    this.setCalls.push(context);
    this.active = context;
  }

  async clearActivePhaseContext(
    reason: "cleared" | "binding-compensation" | "binding-reconciliation" | "phase-rebound",
  ) {
    this.clearReasons.push(reason);
    this.active = undefined;
    this.leaseMarker = undefined;
  }

  getRoadmapPhaseLeaseMarker() {
    return this.leaseMarker;
  }

  async setRoadmapPhaseLeaseMarker(marker: RoadmapPhaseLeaseMarkerV1) {
    this.leaseMarker = marker;
  }
}

async function fixtureDocument(): Promise<NotesDocumentV3> {
  const raw = JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
  const validation = validateNotesDocumentV3(raw);
  if (!validation.ok) throw new Error(`Invalid fixture: ${validation.error.path}`);
  return structuredClone(validation.document);
}

async function setup(name: string, previousSession = sessionA) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `gg-phase-binding-${name}-`));
  roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const document = await fixtureDocument();
  const phase = document.phases[0]!;
  phase.id = "phase-1";
  phase.status = "in-progress";
  phase.session = previousSession;
  phase.reminder = null;
  phase.attentionReason = null;
  phase.completedAt = null;
  phase.archivedAt = null;
  phase.overrides.status = null;
  phase.pendingAutomaticLifecycleTransition = null;
  phase.lifecycleEvents = [];
  phase.roadmapEvents = [];
  document.phases = [phase];
  const migrated = await repository.migrate(cwd, document);
  if (migrated.status !== "ok") throw new Error(`Failed binding fixture: ${migrated.status}`);
  return { cwd, repository, agentDir: path.join(root, "agent") };
}

describe("transparent status leases", () => {
  it.each([
    "expired-owner",
    "released",
    "dead-predecessor",
    "live-competitor",
    "unknown-competitor",
    "wrong-process-token",
    "stale-fence",
  ] as const)("reconciles retained status markers: %s", async (scenario) => {
    const { cwd, repository, agentDir } = await setup(`status-retained-${scenario}`);
    let clock = new Date("2026-09-07T00:00:00.000Z");
    const leases = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => clock,
      processLiveness: async () =>
        scenario === "dead-predecessor"
          ? "dead"
          : scenario === "unknown-competitor"
            ? "unknown"
            : "alive",
    });
    const options = {
      repository,
      leaseRepository: leases,
      daemonInstanceId: "status-daemon",
      processId: process.pid,
      processStartToken: "status-start",
    };
    const original = createAppSidecarPhaseBindingService(options);
    const owner = new FakeSession(cwd, sessionA);
    const acquired = await original.lease(leaseRequest(cwd, "acquire"), owner);
    if (acquired.status !== "acquired") throw new Error("Expected lease");
    const marker = structuredClone(owner.leaseMarker!);
    if (scenario === "released") {
      expect(await original.releaseCurrent("release", owner)).toMatchObject({ status: "released" });
    }
    clock = new Date(clock.getTime() + PHASE_LEASE_TTL_MS + 1);
    const competing = scenario.endsWith("competitor") || scenario === "dead-predecessor";
    const reopened = new FakeSession(cwd, competing ? sessionB : sessionA);
    reopened.leaseMarker = structuredClone(marker);
    if (scenario === "stale-fence") reopened.leaseMarker.fence += 1;
    const retained = structuredClone(reopened.leaseMarker);
    const service = createAppSidecarPhaseBindingService({
      ...options,
      ...(competing ? { daemonInstanceId: "reopened-daemon" } : {}),
      ...(scenario === "wrong-process-token" ? { processStartToken: "different-start" } : {}),
    });
    const before = await repository.load(cwd);
    if (before.status !== "ok") throw new Error("Expected Notes");
    const operation = vi.fn(() =>
      repository.recordRoadmapStatusUpdate(cwd, {
        updateId: "reopened-status",
        phaseId: "phase-1",
        expectedRevision: before.snapshot.revision,
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Recorded progress from reopened session",
        verification: null,
        evidence: [],
        blocker: null,
        requiredExternalAction: null,
        verificationReason: null,
        proposedReferences: [],
        timestamp: clock.toISOString(),
        autopilotEnabled: false,
      }),
    );
    const allowed = ["expired-owner", "released", "dead-predecessor"].includes(scenario);
    const result = await service.withStatusLease(reopened, "phase-1", operation);
    expect(result).toMatchObject(
      allowed
        ? { status: "executed", value: { status: "committed" } }
        : { status: "phase-lease-lost" },
    );
    expect(operation).toHaveBeenCalledTimes(allowed ? 1 : 0);
    const after = await repository.load(cwd);
    if (after.status !== "ok") throw new Error("Expected Notes");
    expect(after.snapshot.document.phases[0]?.session).toEqual(
      before.snapshot.document.phases[0]?.session,
    );
    expect(after.snapshot.document.phases[0]?.execution).toEqual(
      before.snapshot.document.phases[0]?.execution,
    );
    if (!allowed) expect(after).toEqual(before);
    expect(reopened.leaseMarker).toEqual(retained);
    expect(reopened.setCalls).toEqual([]);
    expect(reopened.clearReasons).toEqual([]);
    const inspected = await leases.execute({
      cwd,
      request: {
        ...leaseRequest(cwd, "inspect"),
        action: "inspect",
        expectedRevision: after.snapshot.revision,
      },
      holder: {
        daemonInstanceId: options.daemonInstanceId,
        processId: options.processId,
        processStartToken: options.processStartToken,
        ...sessionA,
      },
      context: {
        projectKey: after.snapshot.projectKey,
        roadmapRevision: after.snapshot.revision,
        phaseId: "phase-1",
        phaseStatus: "in-progress",
        planId: null,
      },
    });
    expect(inspected).toMatchObject({
      status: "inspected",
      lease: allowed ? null : acquired.lease,
    });
  });

  it("lets a fresh host record Done and replay without changing historical session or execution", async () => {
    const { cwd, repository, agentDir } = await setup("status-fresh");
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir),
      daemonInstanceId: "status-daemon",
      processId: process.pid,
      processStartToken: "status-start",
    });
    const fresh = new FakeSession(cwd, sessionB);
    const before = await repository.load(cwd);
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      broadcastNotesSnapshot: () => {},
      mutateStatusWithLeaseFence: (phaseId, operation) =>
        service.withStatusLease(fresh, phaseId, operation),
    });
    const [tool] = host.createSessionTools("coding", () => ({
      getActivePhaseContext: () => undefined,
      getState: () => fresh.getState(),
    }));
    const input = RoadmapStatusParams.parse({
      update_id: "fresh-done",
      phase_id: "phase-1",
      expected_revision: 1,
      transition: "done",
      progress: "Inspected documentation and checked implementation",
      evidence: ["A single focused check covers the related requirements"],
      verification: { result: "passed" },
    });
    for (const result of ["committed", "duplicate"]) {
      const output = await tool!.execute(input, {} as never);
      if (typeof output !== "string") throw new Error("Expected serialized Roadmap response");
      expect(JSON.parse(output)).toMatchObject({ result, revision: 2, statusOutcome: "applied" });
    }
    const after = await repository.load(cwd);
    if (before.status !== "ok" || after.status !== "ok") throw new Error("Expected Notes");
    expect(after.snapshot.document.phases[0]).toMatchObject({ status: "done", session: sessionA });
    expect(after.snapshot.document.phases[0]!.execution).toEqual(
      before.snapshot.document.phases[0]!.execution,
    );
    expect(fresh.setCalls).toEqual([]);
    expect(fresh.leaseMarker).toBeUndefined();
    expect(
      await service.lease(
        { ...leaseRequest(cwd, "no-new-run-after-done"), expectedRevision: 2 },
        fresh,
      ),
    ).toEqual({ status: "phase-terminal" });
  });

  it.each(["heartbeat", "run-finally"])(
    "keeps an acquired owner renewable after Done during %s",
    async (pathUnderTest) => {
      const { cwd, repository, agentDir } = await setup(`status-owner-${pathUnderTest}`);
      const service = createAppSidecarPhaseBindingService({
        repository,
        leaseRepository: new RoadmapPhaseLeaseRepository(agentDir),
        daemonInstanceId: "status-daemon",
        processId: process.pid,
        processStartToken: "status-start",
      });
      const owner = new FakeSession(cwd, sessionA);
      expect(await service.lease(leaseRequest(cwd, "owner-acquire"), owner)).toMatchObject({
        status: "acquired",
      });
      const marker = owner.leaseMarker!;
      const before = await repository.load(cwd);
      if (before.status !== "ok") throw new Error("Expected Notes");
      const finish = async () => {
        const result = await service.withStatusLease(owner, "phase-1", () =>
          repository.recordRoadmapStatusUpdate(cwd, {
            updateId: "owner-done",
            phaseId: "phase-1",
            expectedRevision: before.snapshot.revision,
            actor: "gg-coder",
            transition: "done",
            progress: "Checked the requested behavior",
            verification: "passed",
            evidence: ["Focused checks passed"],
            blocker: null,
            requiredExternalAction: null,
            verificationReason: null,
            proposedReferences: [],
            timestamp: "2026-09-07T00:00:00.000Z",
            autopilotEnabled: false,
          }),
        );
        expect(result).toMatchObject({ status: "executed", value: { status: "committed" } });
      };
      const renewCurrent = async (operationId: string) => {
        const loaded = await repository.load(cwd);
        if (loaded.status !== "ok") throw new Error("Expected Notes");
        const result = await service.lease(
          {
            ...leaseRequest(cwd, operationId),
            action: "renew",
            expectedRevision: loaded.snapshot.revision,
            planId: marker.planId,
            lease: { leaseId: marker.leaseId, fence: marker.fence },
          },
          owner,
        );
        if (result.status !== "renewed") throw new Error(`Renewal failed: ${result.status}`);
      };
      if (pathUnderTest === "heartbeat") {
        await finish();
        const setCalls = owner.setCalls.length;
        await expect(renewCurrent("heartbeat")).resolves.toBeUndefined();
        expect(owner.setCalls).toHaveLength(setCalls);
      } else {
        // Execute the actual sidecar bracket without launching a daemon or provider.
        const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
        const start = source.indexOf("  async function runAgent(");
        const end = source.indexOf("  const planHandoff =", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const observed: string[] = [];
        const context = {
          runLifecycle: {
            running: false,
            generation: 1,
            state: "idle",
            begin: () => ({ generation: 1 }),
            isCancellationRequested: () => false,
            recordOutcome: (_generation: number, outcome: string) =>
              observed.push(`outcome:${outcome}`),
          },
          abortOwnedWork: () => {},
          pendingCancelDrain: null,
          cancelGeneration: 0,
          session: {
            getMessages: () => [],
            getActivePhaseContext: () => owner.active,
            getQueuedCount: () => 0,
            listQueuedMessages: () => [],
          },
          countAssistantMessages: () => 0,
          settleProgrammaticRun: () => undefined,
          broadcast: (event: string) => observed.push(event),
          broadcastError: vi.fn(),
          renewCurrentPhaseLease: renewCurrent,
          getGitBranch: async () => null,
          isGitRepo: async () => false,
          getGitDirtyFileCount: async () => 0,
          gitBranch: null,
          gitIsRepo: false,
          gitDirtyFileCount: 0,
          cwd,
          refreshGitHubCounts: async () => {},
          ciPoll: { refresh: async () => {} },
          finishOwnedGeneration: () => observed.push("cleanup"),
          runJournalPersistence: {
            then: (resolve: () => void) => {
              observed.push("journal-settled");
              resolve();
            },
          },
          settleDeferredPhaseLeaseRelease: async () => false,
          planGate: { pending: () => false },
          approvedPlanPath: null,
          createRunEndPayload: (outcome: string) => ({ outcome }),
          pruneDoneTasksSync: () => [],
          footerExtras: () => ({}),
        };
        const code = ts.transpileModule(`${source.slice(start, end)}\nrunAgent;`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const runAgent = vm.runInNewContext(code, context) as (
          label: string,
          run: () => Promise<void>,
        ) => Promise<void>;
        await expect(runAgent("Done while running", finish)).resolves.toBeUndefined();
        expect(context.broadcastError).not.toHaveBeenCalled();
        expect(observed).toEqual([
          "run_start",
          "outcome:completed",
          "cleanup",
          "journal-settled",
          "run_end",
          "tasks_list",
          "queued",
          "extras",
        ]);
      }
      expect(owner.leaseMarker).toEqual(marker);
      const terminal = await repository.load(cwd);
      if (terminal.status !== "ok") throw new Error("Expected Notes");
      const renewal: PhaseLeaseRequestV2 = {
        ...leaseRequest(cwd, "unauthorized-renew"),
        action: "renew",
        expectedRevision: terminal.snapshot.revision,
        planId: marker.planId,
        lease: { leaseId: marker.leaseId, fence: marker.fence },
      };
      expect(await service.lease(renewal, new FakeSession(cwd, sessionB))).toMatchObject({
        status: "phase-lease-lost",
      });
      expect(
        await service.lease(
          {
            ...renewal,
            operationId: "stale-fence-renew",
            lease: { leaseId: marker.leaseId, fence: marker.fence + 1 },
          },
          owner,
        ),
      ).toMatchObject({ status: "phase-lease-lost" });
      expect(await service.releaseCurrent("owner-release", owner)).toMatchObject({
        status: "released",
      });
      expect(owner.leaseMarker).toBeUndefined();
      expect(owner.active).toBeUndefined();
      const after = await new ProjectNotesRepository(agentDir).load(cwd);
      if (after.status !== "ok") throw new Error("Expected durable Notes");
      expect(after.snapshot.document.phases[0]?.status).toBe("done");
      expect(after.snapshot.document.phases[0]?.execution).toEqual(
        before.snapshot.document.phases[0]?.execution,
      );
      expect(
        await service.lease(
          {
            ...leaseRequest(cwd, "new-owner"),
            expectedRevision: after.snapshot.revision,
          },
          new FakeSession(cwd, sessionB),
        ),
      ).toEqual({ status: "phase-terminal" });
    },
  );

  it("reports a missing phase without invoking a mutation or inventing a lease conflict", async () => {
    const { cwd, repository, agentDir } = await setup("status-missing-phase");
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir),
      daemonInstanceId: "status-daemon",
      processId: process.pid,
      processStartToken: "status-start",
    });
    const operation = vi.fn(async () => "updated");
    expect(
      await service.withStatusLease(new FakeSession(cwd, sessionB), "missing-phase", operation),
    ).toEqual({ status: "phase-not-found" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("protects another runner and releases transient leases after failure", async () => {
    const { cwd, repository, agentDir } = await setup("status-conflict");
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir),
      daemonInstanceId: "status-daemon",
      processId: process.pid,
      processStartToken: "status-start",
    });
    const first = new FakeSession(cwd, sessionA);
    const second = new FakeSession(cwd, sessionB);
    expect(await service.lease(leaseRequest(cwd, "runner-acquire"), first)).toMatchObject({
      status: "acquired",
    });
    const operation = vi.fn(async () => "updated");
    expect(await service.withStatusLease(second, "phase-1", operation)).toEqual({
      status: "phase-lease-lost",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(await service.releaseCurrent("runner-release", first)).toMatchObject({
      status: "released",
    });
    await expect(
      service.withStatusLease(second, "phase-1", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(await service.withStatusLease(second, "phase-1", operation)).toEqual({
      status: "executed",
      value: "updated",
    });
  });
});

function request(cwd: string, overrides: Partial<PhaseBindingRequest> = {}): PhaseBindingRequest {
  return {
    version: 1,
    action: "rebind-current",
    phaseId: "phase-1",
    expectedProjectKey: canonicalProjectKey(cwd),
    expectedRevision: 1,
    expectedPreviousSession: sessionA,
    operationId: "operation-1",
    confirmRebind: true,
    ...overrides,
  };
}

function leaseRequest(cwd: string, operationId: string): PhaseLeaseRequestV2 {
  return {
    version: 2,
    action: "acquire",
    phaseId: "phase-1",
    expectedProjectKey: canonicalProjectKey(cwd),
    expectedRevision: 1,
    planId: null,
    operationId,
    lease: null,
    confirmTakeover: false,
    takeoverReason: null,
    predecessorProof: null,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("app sidecar phase binding service", () => {
  it("persists destination context and fans out one authoritative snapshot", async () => {
    const { cwd, repository } = await setup("commit");
    const aliasCwd = `${cwd}${path.sep}.`;
    const otherCwd = path.join(cwd, "..", "other-project");
    const deliveries = new Map<string, ProjectNotesSnapshot[]>([
      [cwd, []],
      [aliasCwd, []],
      [otherCwd, []],
    ]);
    const service = createAppSidecarPhaseBindingService({
      repository,
      now: () => "2026-07-25T12:36:00.000Z",
      onCommittedSnapshot: (snapshot) => {
        for (const [projectCwd, events] of deliveries) {
          if (canonicalProjectKey(projectCwd) === snapshot.projectKey) events.push(snapshot);
        }
      },
    });
    const session = new FakeSession(cwd, sessionB);

    await expect(service.bind(request(cwd), session)).resolves.toMatchObject({
      status: "committed",
      revision: 2,
      previousSession: sessionA,
      session: sessionB,
    });
    expect(session.setCalls).toHaveLength(1);
    expect(session.active).toMatchObject({
      projectKey: canonicalProjectKey(cwd),
      phase: { id: "phase-1" },
      session: sessionB,
    });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { phases: [{ session: sessionB }] } },
    });
    expect(deliveries.get(cwd)).toHaveLength(1);
    expect(deliveries.get(aliasCwd)).toHaveLength(1);
    expect(deliveries.get(otherCwd)).toHaveLength(0);
  });

  it("does not publish when repository compare-and-swap rejects", async () => {
    const { cwd, repository } = await setup("compensation");
    const bindPhaseToCurrentSession = vi.fn(async () => ({
      status: "stale-revision" as const,
      revision: 2,
    }));
    const onCommittedSnapshot = vi.fn();
    const service = createAppSidecarPhaseBindingService({
      repository: {
        load: (project) => repository.load(project),
        bindPhaseToCurrentSession,
        reconcilePhaseExecution: repository.reconcilePhaseExecution.bind(repository),
      },
      onCommittedSnapshot,
    });
    const session = new FakeSession(cwd, sessionB);

    await expect(service.bind(request(cwd), session)).resolves.toEqual({
      status: "stale-revision",
      revision: 2,
    });
    expect(session.setCalls).toHaveLength(0);
    expect(session.clearReasons).toEqual([]);
    expect(session.active).toBeUndefined();
    expect(onCommittedSnapshot).not.toHaveBeenCalled();
  });

  it("keeps authoritative Notes committed when context persistence fails", async () => {
    const { cwd, repository } = await setup("context-failure");
    const bindPhaseToCurrentSession = vi.fn(repository.bindPhaseToCurrentSession.bind(repository));
    const service = createAppSidecarPhaseBindingService({
      repository: {
        load: (project) => repository.load(project),
        bindPhaseToCurrentSession,
        reconcilePhaseExecution: repository.reconcilePhaseExecution.bind(repository),
      },
    });
    const session = new FakeSession(cwd, sessionB);
    session.setActivePhaseContext = vi.fn(async () => {
      throw new Error("transcript append failed");
    });

    await expect(service.bind(request(cwd), session)).rejects.toThrow("transcript append failed");
    expect(bindPhaseToCurrentSession).toHaveBeenCalledOnce();
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { phases: [{ session: sessionB }] } },
    });
  });

  it("clears a former session after restoration detects a rebind", async () => {
    const { cwd, repository } = await setup("reconcile");
    const service = createAppSidecarPhaseBindingService({ repository });
    const destination = new FakeSession(cwd, sessionB);
    await service.bind(request(cwd), destination);
    const former = new FakeSession(cwd, sessionA);
    former.active = destination.active ? { ...destination.active, session: sessionA } : undefined;

    await expect(service.reconcile(former)).resolves.toBe("cleared");
    expect(former.clearReasons).toEqual(["phase-rebound"]);
    expect(former.active).toBeUndefined();
    await expect(service.reconcile(destination)).resolves.toBe("consistent");
  });

  it("fails closed when the authenticated destination lacks a persistent path", async () => {
    const { cwd, repository } = await setup("missing-path");
    const service = createAppSidecarPhaseBindingService({ repository });
    const session = new FakeSession(cwd, { sessionId: "ephemeral", sessionPath: null });

    await expect(service.bind(request(cwd), session)).resolves.toEqual({
      status: "missing-session-path",
    });
    expect(session.setCalls).toHaveLength(0);
  });
  it("maps legacy binds to fenced leases and advances the Notes session revision", async () => {
    const { cwd, repository, agentDir } = await setup("leases");
    let leaseId = 0;
    const leaseRepository = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => `lease-${++leaseId}`,
      processLiveness: async () => "alive",
    });
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository,
      daemonInstanceId: "daemon-1",
      processId: 123,
      processStartToken: "start-1",
    });
    const destination = new FakeSession(cwd, sessionB);
    const first = await service.bind(request(cwd), destination);
    expect(first).toMatchObject({
      status: "committed",
      revision: 2,
      session: sessionB,
    });
    expect(destination.leaseMarker).toMatchObject({ leaseId: "lease-1", fence: 1 });
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { phases: [{ session: sessionB }] } },
    });

    const competitor = new FakeSession(cwd, sessionC);
    expect(
      await service.bind(
        request(cwd, {
          action: "bind-current",
          expectedPreviousSession: null,
          confirmRebind: false,
          operationId: "competitor",
          expectedRevision: 2,
        }),
        competitor,
      ),
    ).toMatchObject({ status: "already-bound", revision: 2, session: sessionB });

    expect(
      await service.bind(
        request(cwd, {
          expectedPreviousSession: sessionB,
          expectedRevision: 2,
          operationId: "move",
        }),
        competitor,
      ),
    ).toMatchObject({ status: "committed", revision: 3, session: sessionC });
    expect(competitor.leaseMarker).toMatchObject({ leaseId: "lease-2", fence: 2 });
    await expect(service.reconcile(destination)).resolves.toBe("cleared");
    expect(destination.clearReasons).toEqual(["phase-rebound"]);
    await expect(service.reconcile(competitor)).resolves.toBe("consistent");
  });

  it("commits Notes before markers and replays the lease after Notes revision advances", async () => {
    const { cwd, repository, agentDir } = await setup("lease-notes-order");
    const leases = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "ordered-lease",
    });
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-order",
      processId: 123,
      processStartToken: "start-order",
      now: () => "2026-08-30T10:00:00.000Z",
    });
    const destination = new FakeSession(cwd, sessionB);
    const persistMarker = destination.setRoadmapPhaseLeaseMarker.bind(destination);
    destination.setRoadmapPhaseLeaseMarker = vi.fn(async (marker) => {
      await expect(repository.load(cwd)).resolves.toMatchObject({
        status: "ok",
        snapshot: { revision: 2, document: { phases: [{ session: sessionB }] } },
      });
      await persistMarker(marker);
    });
    const acquire = leaseRequest(cwd, "ordered-acquire");

    await expect(service.lease(acquire, destination)).resolves.toMatchObject({
      status: "acquired",
      roadmapRevision: 2,
    });
    await expect(service.lease(acquire, destination)).resolves.toMatchObject({
      status: "duplicate",
      roadmapRevision: 2,
    });
    expect(destination.setRoadmapPhaseLeaseMarker).toHaveBeenCalledTimes(2);
  });

  it("releases the current fence and clears markers after committed or duplicate release", async () => {
    const { cwd, repository, agentDir } = await setup("lease-release");
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir, {
        now: () => new Date("2026-08-30T10:00:00.000Z"),
        createId: () => "lease-release",
      }),
      daemonInstanceId: "daemon-release",
      processId: 123,
      processStartToken: "start-release",
    });
    const destination = new FakeSession(cwd, sessionB);
    await service.lease(leaseRequest(cwd, "acquire-release"), destination);
    const lingeringMarker = destination.leaseMarker;
    const lingeringContext = destination.active;
    if (!lingeringMarker || !lingeringContext) throw new Error("expected acquired lease");

    await expect(service.releaseCurrent("release-current", destination)).resolves.toMatchObject({
      status: "released",
      lease: null,
    });
    expect(destination.leaseMarker).toBeUndefined();

    destination.leaseMarker = lingeringMarker;
    destination.active = lingeringContext;
    await expect(service.releaseCurrent("release-current", destination)).resolves.toMatchObject({
      status: "duplicate",
      lease: null,
    });
    expect(destination.leaseMarker).toBeUndefined();
    expect(destination.clearReasons).toEqual(["cleared", "cleared"]);
  });

  it("recovers a lease immediately after a proved daemon restart", async () => {
    const { cwd, repository, agentDir } = await setup("supervised-restart");
    const leaseRepository = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date("2026-08-30T10:00:01.000Z"),
      createId: () => "lease-restart",
      processLiveness: async () => "alive",
    });
    const oldService = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository,
      daemonInstanceId: "daemon-old",
      processId: 123,
      processStartToken: "start-old",
    });
    const previous = new FakeSession(cwd, sessionB);
    await oldService.bind(request(cwd), previous);
    if (!previous.active || !previous.leaseMarker) throw new Error("expected bound lease");

    const resumed = new FakeSession(cwd, {
      sessionId: "session-resumed",
      sessionPath: sessionB.sessionPath,
    });
    resumed.active = previous.active;
    resumed.leaseMarker = previous.leaseMarker;
    const newService = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository,
      daemonInstanceId: "daemon-new",
      processId: 456,
      processStartToken: "start-new",
      predecessorProof: {
        daemonInstanceId: "daemon-old",
        processId: 123,
        processStartToken: "start-old",
        terminatedAt: "2026-08-30T10:00:00.500Z",
      },
    });

    await expect(newService.reconcile(resumed)).resolves.toBe("consistent");
    expect(resumed.active?.session).toEqual({
      sessionId: "session-resumed",
      sessionPath: sessionB.sessionPath,
    });
    expect(resumed.leaseMarker).toMatchObject({ fence: 2, daemonInstanceId: "daemon-new" });
    expect(resumed.clearReasons).toEqual([]);
  });

  it("recreates missing markers from Notes after the binding CAS committed", async () => {
    const { cwd, repository, agentDir } = await setup("notes-cas-marker");
    const binding = createAppSidecarPhaseBindingService({ repository });
    const interrupted = new FakeSession(cwd, sessionB);
    interrupted.setActivePhaseContext = vi.fn(async () => {
      throw new Error("marker append interrupted");
    });
    await expect(binding.bind(request(cwd), interrupted)).rejects.toThrow(
      "marker append interrupted",
    );

    const resumed = new FakeSession(cwd, sessionB);
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir, {
        now: () => new Date("2026-08-30T10:00:00.000Z"),
        createId: () => "lease-from-notes",
      }),
      daemonInstanceId: "daemon-resumed",
      processId: 456,
      processStartToken: "start-resumed",
      now: () => "2026-08-30T10:00:00.000Z",
    });

    await expect(service.reconcile(resumed)).resolves.toBe("consistent");
    expect(resumed.active).toMatchObject({ phase: { id: "phase-1" }, session: sessionB });
    expect(resumed.leaseMarker).toMatchObject({ leaseId: "lease-from-notes", fence: 1 });
  });

  it("takes an expired lease only after its holder is proven dead", async () => {
    const { cwd, repository, agentDir } = await setup("expired-dead", sessionB);
    let now = Date.parse("2026-08-30T10:00:00.000Z");
    let liveness: "alive" | "dead" | "unknown" = "alive";
    let leaseId = 0;
    const leases = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date(now),
      createId: () => `lease-${++leaseId}`,
      processLiveness: async () => liveness,
    });
    const previous = new FakeSession(cwd, sessionB);
    const oldService = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-old",
      processId: 123,
      processStartToken: "start-old",
      now: () => new Date(now).toISOString(),
    });
    await oldService.lease(leaseRequest(cwd, "initial-acquire"), previous);

    now += PHASE_LEASE_TTL_MS + 1;
    liveness = "dead";
    const resumed = new FakeSession(cwd, {
      sessionId: "session-resumed",
      sessionPath: sessionB.sessionPath,
    });
    const newService = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-new",
      processId: 456,
      processStartToken: "start-new",
      now: () => new Date(now).toISOString(),
    });

    await expect(newService.reconcile(resumed)).resolves.toBe("consistent");
    expect(resumed.leaseMarker).toMatchObject({ leaseId: "lease-2", fence: 2 });
  });

  it("fails closed when an expired holder's liveness is uncertain", async () => {
    const { cwd, repository, agentDir } = await setup("expired-unknown", sessionB);
    let now = Date.parse("2026-08-30T10:00:00.000Z");
    let liveness: "alive" | "dead" | "unknown" = "alive";
    const leases = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date(now),
      createId: () => "lease-uncertain",
      processLiveness: async () => liveness,
    });
    const previous = new FakeSession(cwd, sessionB);
    await createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-old",
      processId: 123,
      processStartToken: "start-old",
      now: () => new Date(now).toISOString(),
    }).lease(leaseRequest(cwd, "initial-acquire"), previous);

    now += PHASE_LEASE_TTL_MS + 1;
    liveness = "unknown";
    const resumed = new FakeSession(cwd, {
      sessionId: "session-resumed",
      sessionPath: sessionB.sessionPath,
    });
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-new",
      processId: 456,
      processStartToken: "start-new",
      now: () => new Date(now).toISOString(),
    });

    await expect(service.reconcile(resumed)).resolves.toBe("cleared");
    expect(resumed.active).toBeUndefined();
    expect(resumed.leaseMarker).toBeUndefined();
  });

  it("recovers a crash after lease acquisition and reruns legacy import behind its fence", async () => {
    const { cwd, repository, agentDir } = await setup("migration-crash", sessionB);
    let now = Date.parse("2026-08-30T10:00:00.000Z");
    let liveness: "alive" | "dead" = "alive";
    let leaseId = 0;
    const leases = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date(now),
      createId: () => `migration-lease-${++leaseId}`,
      processLiveness: async () => liveness,
    });
    const interrupted = new FakeSession(cwd, sessionB);
    interrupted.setActivePhaseContext = vi.fn(async () => {
      throw new Error("crashed before import");
    });
    const oldService = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-old",
      processId: 123,
      processStartToken: "start-old",
      now: () => new Date(now).toISOString(),
    });
    await expect(
      oldService.lease(leaseRequest(cwd, "migration-acquire"), interrupted),
    ).rejects.toThrow("crashed before import");

    now += PHASE_LEASE_TTL_MS + 1;
    liveness = "dead";
    const resumed = new FakeSession(cwd, {
      sessionId: "session-resumed",
      sessionPath: sessionB.sessionPath,
    });
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: leases,
      daemonInstanceId: "daemon-new",
      processId: 456,
      processStartToken: "start-new",
      now: () => new Date(now).toISOString(),
    });
    await expect(service.reconcile(resumed)).resolves.toBe("consistent");

    const execution = {
      version: 1 as const,
      state: "needs-reconciliation" as const,
      repository: {
        projectKey: canonicalProjectKey(cwd),
        identityHash: "1".repeat(64),
        rootCommit: "2".repeat(40),
      },
      plan: null,
      evidence: [],
      pendingCompletion: null,
      lastSession: { sessionId: "session-resumed", sessionPath: sessionB.sessionPath },
      migration: { source: "legacy-session" as const, reconciledAt: null },
    };
    const importExecution = () =>
      repository.importLegacyPhaseExecution(cwd, {
        operationId: "legacy-migration:phase-1",
        phaseId: "phase-1",
        expectedRevision: 2,
        execution,
      });
    await expect(service.withLeaseFence(resumed, importExecution)).resolves.toMatchObject({
      status: "executed",
      value: { status: "committed", snapshot: { revision: 3 } },
    });
    await expect(service.withLeaseFence(resumed, importExecution)).resolves.toMatchObject({
      status: "executed",
      value: { status: "duplicate", revision: 3 },
    });
  });

  it("reconciles through the held lease and returns the exact public outcome", async () => {
    const { cwd, repository, agentDir } = await setup("reconciliation-success");
    const stepId = "6".repeat(64);
    const repositoryIdentity = {
      projectKey: canonicalProjectKey(cwd),
      identityHash: "1".repeat(64),
      rootCommit: "2".repeat(40),
    };
    const workspace = {
      version: 1 as const,
      repository: repositoryIdentity,
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: true,
    };
    const plan = {
      planId: "plan-1",
      contentHash: "5".repeat(64),
      snapshotPath: ".gg/plans/plan-1.md",
      approvedAt: "2026-08-31T10:00:00.000Z",
      approvedRevision: 1,
      baseCommit: repositoryIdentity.rootCommit,
      steps: [
        {
          id: stepId,
          index: 1,
          text: "Preserve completed work",
          state: "completed" as const,
          completedAt: "2026-08-31T10:01:00.000Z",
          workspace,
        },
      ],
    };
    await expect(
      repository.importLegacyPhaseExecution(cwd, {
        operationId: "legacy-migration:phase-1",
        phaseId: "phase-1",
        expectedRevision: 1,
        execution: {
          version: 1,
          state: "needs-reconciliation",
          repository: repositoryIdentity,
          plan,
          evidence: [],
          pendingCompletion: null,
          lastSession: sessionA,
          migration: { source: "legacy-session", reconciledAt: null },
        },
      }),
    ).resolves.toMatchObject({ status: "committed", snapshot: { revision: 2 } });

    const leaseRepository = new RoadmapPhaseLeaseRepository(agentDir, {
      now: () => new Date("2026-08-31T10:02:00.000Z"),
      createId: () => "lease-reconcile",
    });
    const onCommittedSnapshot = vi.fn();
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository,
      daemonInstanceId: "daemon-reconcile",
      processId: 123,
      processStartToken: "start-reconcile",
      now: () => "2026-08-31T10:03:00.000Z",
      captureWorkspace: async () => workspace,
      resolvePlanSnapshot: async () => ({
        status: "ready",
        path: plan.snapshotPath,
        content: "# Plan",
        recovered: false,
      }),
      isAncestor: async () => true,
      onCommittedSnapshot,
    });
    const session = new FakeSession(cwd, sessionB);
    await expect(
      service.lease(
        { ...leaseRequest(cwd, "acquire-reconcile"), expectedRevision: 2, planId: plan.planId },
        session,
      ),
    ).resolves.toMatchObject({ status: "acquired", roadmapRevision: 3 });
    const reconciliation: PhaseExecutionReconciliationRequestV3 = {
      version: 3,
      action: "reconcile-execution",
      phaseId: "phase-1",
      expectedProjectKey: canonicalProjectKey(cwd),
      expectedRevision: 3,
      operationId: "reconcile-1",
      repository: repositoryIdentity,
      plan: {
        planId: plan.planId,
        contentHash: plan.contentHash,
        snapshotPath: plan.snapshotPath,
        approvedAt: plan.approvedAt,
        approvedRevision: plan.approvedRevision,
        baseCommit: plan.baseCommit,
      },
      workspace,
    };

    await expect(service.reconcilePhaseExecution(reconciliation, session)).resolves.toEqual({
      status: "reconciled",
      revision: 4,
      phaseId: "phase-1",
      preservedStepIds: [stepId],
      revalidationStepIds: [],
      revalidationEvidenceCount: 0,
      reconciledAt: "2026-08-31T10:03:00.000Z",
    });
    expect(onCommittedSnapshot).toHaveBeenCalledTimes(2);
    expect(onCommittedSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 4 }));
  });

  it("denies reconciliation before the repository write when the lease fence is absent", async () => {
    const { cwd, repository, agentDir } = await setup("reconciliation-fence");
    const service = createAppSidecarPhaseBindingService({
      repository,
      leaseRepository: new RoadmapPhaseLeaseRepository(agentDir),
      daemonInstanceId: "daemon-fence",
      processId: 123,
      processStartToken: "start-fence",
    });
    const session = new FakeSession(cwd, sessionB);
    const reconcile = vi.spyOn(repository, "reconcilePhaseExecution");

    await expect(service.reconcilePhaseExecution({} as never, session)).resolves.toEqual({
      status: "phase-lease-lost",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
