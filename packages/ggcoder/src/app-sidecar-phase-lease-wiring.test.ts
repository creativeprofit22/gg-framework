import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalProjectKey, validateNotesDocumentV3 } from "@kenkaiiii/gg-core/project-notes";
import type { PhaseLeaseRequestV2 } from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  createAppSidecarPhaseBindingService,
  hasLivePhaseLeaseSession,
  type AppSidecarPhaseBindingService,
  type PhaseBindingSession,
} from "./app-sidecar-phase-binding.js";
import type { ActivePhaseContextV1, RoadmapPhaseLeaseMarkerV1 } from "./phase-context.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import {
  PHASE_LEASE_TTL_MS,
  RoadmapPhaseLeaseRepository,
  type RoadmapPhaseLeaseHolderV1,
} from "./roadmap-phase-lease-repository.js";

/*
 * app-sidecar.ts is the daemon entry point (it runs main() on import), so these
 * tests compile the production wiring expressions out of its source and run
 * them against the real lease repository and phase binding service. Removing
 * either wire from the daemon fails here even though the repository/binding
 * unit tests (which construct their own options) would still pass.
 */

const APP_SIDECAR = new URL("./app-sidecar.ts", import.meta.url);
const sessionA = { sessionId: "session-a", sessionPath: "/sessions/a.jsonl" };
const sessionB = { sessionId: "session-b", sessionPath: "/sessions/b.jsonl" };
const sessionC = { sessionId: "session-c", sessionPath: "/sessions/c.jsonl" };
type SessionLink = { sessionId: string; sessionPath: string | null };

/** A daemon session whose id rotates the way a compaction checkpoint rotates it. */
class CompactingSession implements PhaseBindingSession {
  active: ActivePhaseContextV1 | undefined;
  leaseMarker: RoadmapPhaseLeaseMarkerV1 | undefined;
  runState: "idle" | "running" = "idle";
  private current: SessionLink;
  private readonly predecessors: SessionLink[] = [];

  constructor(
    readonly cwd: string,
    initial: SessionLink,
  ) {
    this.current = { ...initial };
  }

  getState() {
    return { cwd: this.cwd, ...this.current };
  }
  getActivePhaseContext() {
    return this.active;
  }
  async setActivePhaseContext(context: ActivePhaseContextV1 | undefined) {
    this.active = context;
  }
  getRoadmapPhaseLeaseMarker() {
    return this.leaseMarker;
  }
  async setRoadmapPhaseLeaseMarker(marker: RoadmapPhaseLeaseMarkerV1) {
    this.leaseMarker = marker;
  }
  getPhaseLeaseRunState() {
    return this.runState;
  }
  getCompactionPredecessorSessions() {
    return this.predecessors.map((link) => ({ ...link }));
  }
  compact(next: SessionLink) {
    this.predecessors.push({ ...this.current });
    this.current = { ...next };
    if (this.active) this.active = { ...this.active, session: { ...next } };
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function notesFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `gg-lease-wiring-${name}-`));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const repository = new ProjectNotesRepository(agentDir);
  const raw = JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
  const validation = validateNotesDocumentV3(raw);
  if (!validation.ok) throw new Error(`Invalid fixture: ${validation.error.path}`);
  const document = structuredClone(validation.document);
  const phase = document.phases[0];
  if (!phase) throw new Error("Fixture has no phase");
  Object.assign(phase, {
    id: "phase-1",
    status: "in-progress",
    session: sessionA,
    reminder: null,
    attentionReason: null,
    completedAt: null,
    archivedAt: null,
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  });
  phase.overrides.status = null;
  document.phases = [phase];
  const migrated = await repository.migrate(cwd, document);
  if (migrated.status !== "ok") throw new Error(`Failed Notes fixture: ${migrated.status}`);
  return { cwd, agentDir, repository };
}

async function revision(repository: ProjectNotesRepository, cwd: string): Promise<number> {
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok") throw new Error("Expected Notes");
  return loaded.snapshot.revision;
}

async function phaseSession(repository: ProjectNotesRepository, cwd: string) {
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok") throw new Error("Expected Notes");
  return loaded.snapshot.document.phases[0]?.session;
}

function acquireRequest(cwd: string, operationId: string, expectedRevision: number) {
  return {
    version: 2,
    action: "acquire",
    phaseId: "phase-1",
    expectedProjectKey: canonicalProjectKey(cwd),
    expectedRevision,
    planId: null,
    operationId,
    lease: null,
    confirmTakeover: false,
    takeoverReason: null,
    predecessorProof: null,
  } satisfies PhaseLeaseRequestV2;
}

function markDone(
  service: AppSidecarPhaseBindingService,
  repository: ProjectNotesRepository,
  session: CompactingSession,
  expectedRevision: number,
) {
  return service.withStatusLease(session, "phase-1", () =>
    repository.recordRoadmapStatusUpdate(session.cwd, {
      updateId: "done-after-compaction",
      phaseId: "phase-1",
      expectedRevision,
      actor: "gg-coder",
      transition: "done",
      progress: "Finished after compaction",
      verification: "passed",
      evidence: ["regression suite passed"],
      blocker: null,
      requiredExternalAction: null,
      verificationReason: null,
      proposedReferences: [],
      timestamp: new Date().toISOString(),
      autopilotEnabled: false,
    }),
  );
}

function compile<T>(parameters: string, expression: string, globals: object): T {
  const js = ts.transpileModule(`(${parameters}) => (${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled: unknown = vm.runInNewContext(js, { ...globals });
  if (typeof compiled !== "function") throw new Error("wiring expression did not compile");
  return compiled as T;
}

describe("daemon phase-lease wiring (regression: orphaned leases after compaction)", () => {
  let hasLiveLocalSessionExpressions: string[];
  let compactionHandOffListeners: string[];

  beforeAll(async () => {
    const source = ts.createSourceFile(
      "app-sidecar.ts",
      await fs.readFile(APP_SIDECAR, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    hasLiveLocalSessionExpressions = [];
    compactionHandOffListeners = [];
    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === "RoadmapPhaseLeaseRepository"
      ) {
        const options = node.arguments?.[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "hasLiveLocalSession"
            ) {
              hasLiveLocalSessionExpressions.push(property.initializer.getText(source));
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source).endsWith(".eventBus.on") &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "compaction_end"
      ) {
        const listener = node.arguments[1];
        if (listener && listener.getText(source).includes("handOffCompactedSession")) {
          compactionHandOffListeners.push(listener.getText(source));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  });

  describe("orphan recovery backstop", () => {
    function daemonLeaseRepository(agentDir: string, clock: () => Date) {
      expect(hasLiveLocalSessionExpressions).toHaveLength(1);
      const sessions = new Map<string, { session: CompactingSession }>();
      const predicate = compile<
        (
          sessions: Map<string, { session: CompactingSession }>,
        ) => (holder: RoadmapPhaseLeaseHolderV1) => boolean
      >("sessions", hasLiveLocalSessionExpressions[0] ?? "", { hasLivePhaseLeaseSession });
      const leases = new RoadmapPhaseLeaseRepository(agentDir, {
        now: clock,
        processLiveness: async () => "alive",
        hasLiveLocalSession: predicate(sessions),
      });
      return { sessions, leases };
    }

    async function claimedPhase(name: string) {
      const { cwd, agentDir, repository } = await notesFixture(name);
      let now = new Date("2026-10-05T08:00:00.000Z");
      const { sessions, leases } = daemonLeaseRepository(agentDir, () => now);
      const service = createAppSidecarPhaseBindingService({
        repository,
        leaseRepository: leases,
        daemonInstanceId: "wiring-daemon",
        processId: process.pid,
        processStartToken: "wiring-start",
      });
      const owner = new CompactingSession(cwd, sessionA);
      sessions.set("pane-a", { session: owner });
      const acquired = await service.lease(acquireRequest(cwd, "claim", 1), owner);
      if (acquired.status !== "acquired") throw new Error(`Expected lease: ${acquired.status}`);
      return {
        cwd,
        repository,
        service,
        sessions,
        owner,
        expire: () => {
          now = new Date(now.getTime() + PHASE_LEASE_TTL_MS + 1);
        },
      };
    }

    it("lets a new session reclaim an expired lease whose daemon session is gone", async () => {
      const { cwd, repository, service, sessions, expire } = await claimedPhase("orphan");
      sessions.delete("pane-a");
      const next = new CompactingSession(cwd, sessionB);
      sessions.set("pane-b", { session: next });
      expire();

      const result = await service.lease(
        acquireRequest(cwd, "reclaim", await revision(repository, cwd)),
        next,
      );

      expect(result.status).toBe("acquired");
    });

    it("keeps an expired lease held while its session is still live, including after compaction", async () => {
      const { cwd, repository, service, sessions, owner, expire } =
        await claimedPhase("still-live");
      owner.compact(sessionC);
      const stranger = new CompactingSession(cwd, sessionB);
      sessions.set("pane-b", { session: stranger });
      expire();

      const result = await service.lease(
        acquireRequest(cwd, "steal", await revision(repository, cwd)),
        stranger,
      );

      expect(result.status).toBe("phase-lease-held");
    });
  });

  describe("compaction_end hand-off", () => {
    async function compactedRun(name: string, runState: "idle" | "running") {
      expect(compactionHandOffListeners).toHaveLength(1);
      const { cwd, agentDir, repository } = await notesFixture(name);
      const service = createAppSidecarPhaseBindingService({
        repository,
        leaseRepository: new RoadmapPhaseLeaseRepository(agentDir, {
          processLiveness: async () => "alive",
        }),
        daemonInstanceId: "wiring-daemon",
        processId: process.pid,
        processStartToken: "wiring-start",
      });
      const target = new CompactingSession(cwd, sessionA);
      const acquired = await service.lease(acquireRequest(cwd, "claim", 1), target);
      if (acquired.status !== "acquired") throw new Error(`Expected lease: ${acquired.status}`);
      const heldRevision = await revision(repository, cwd);

      const handOffs: Promise<unknown>[] = [];
      const phaseBinding = {
        handOffCompactedSession: (...args: Parameters<typeof service.handOffCompactedSession>) => {
          const pending = service.handOffCompactedSession(...args);
          handOffs.push(pending);
          return pending;
        },
      };
      const captureSidecarError = vi.fn();
      const listener = compile<(...deps: unknown[]) => (data: { compacted: boolean }) => void>(
        "target, phaseBinding, broadcast, footerExtras, log, captureSidecarError",
        compactionHandOffListeners[0] ?? "",
        {},
      )(target, phaseBinding, vi.fn(), () => ({}), vi.fn(), captureSidecarError);

      target.runState = runState;
      target.compact(sessionC);
      listener({ compacted: true });
      await Promise.all(handOffs);

      expect(handOffs).toHaveLength(1);
      expect(captureSidecarError).not.toHaveBeenCalled();
      return { cwd, repository, service, target, heldRevision };
    }

    it("moves the lease to the new session id mid-run and keeps the held revision valid", async () => {
      const { cwd, repository, service, target, heldRevision } = await compactedRun(
        "mid-run",
        "running",
      );

      // The listener already rotated the lease; a second hand-off has nothing to do.
      expect(await service.handOffCompactedSession(target, { moveNotesLink: false })).toBe(
        "unchanged",
      );
      expect(await revision(repository, cwd)).toBe(heldRevision);
      await expect(markDone(service, repository, target, heldRevision)).resolves.toMatchObject({
        status: "executed",
        value: { status: "committed" },
      });
    });

    it("moves the Notes phase link immediately after an idle compaction", async () => {
      const { cwd, repository, service, target } = await compactedRun("idle", "idle");

      expect(await phaseSession(repository, cwd)).toEqual(sessionC);
      await expect(
        markDone(service, repository, target, await revision(repository, cwd)),
      ).resolves.toMatchObject({ status: "executed", value: { status: "committed" } });
    });
  });
});

describe("hasLivePhaseLeaseSession", () => {
  /** A live session that started as `lineage[0]` and compacted through the rest. */
  const live = (...lineage: [SessionLink, ...SessionLink[]]) => {
    const [first, ...rotations] = lineage;
    const session = new CompactingSession("/project", first);
    for (const link of rotations) session.compact(link);
    return session;
  };

  it.each([
    { name: "a live session id", sessions: [live(sessionA)], holder: "session-a", expected: true },
    {
      name: "a compaction predecessor of a live session",
      sessions: [live(sessionA, sessionC)],
      holder: "session-a",
      expected: true,
    },
    {
      name: "a session no longer live in this process",
      sessions: [live(sessionB), live(sessionA, sessionC)],
      holder: "session-x",
      expected: false,
    },
    { name: "no live sessions", sessions: [], holder: "session-a", expected: false },
  ])("returns $expected for $name", ({ sessions, holder, expected }) => {
    expect(hasLivePhaseLeaseSession(sessions, { sessionId: holder })).toBe(expected);
  });
});
