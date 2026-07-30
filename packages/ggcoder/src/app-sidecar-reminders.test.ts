import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  AppSidecarReminderCoordinator,
  createAppSidecarReminderHandler,
  selectDueReminder,
  type AppSidecarReminderSession,
  type ReminderClock,
} from "./app-sidecar-reminders.js";
import {
  canonicalProjectKey,
  type NotesDocumentV3,
  type ProjectNotesReminderDeliveryRequest,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const NOW_MS = Date.parse("2026-07-28T12:00:00.000Z");
const PROJECT = "C:\\Work\\Reminder";

function notes(
  occurrences: Array<{
    phaseId: string;
    dueAt: string;
    order?: number;
    status?: NotesDocumentV3["phases"][number]["status"];
    archivedAt?: string | null;
    delivered?: boolean;
    occurrenceKey?: string;
    reminderId?: string;
  }> = [{ phaseId: "phase-1", dueAt: new Date(NOW_MS).toISOString() }],
): NotesDocumentV3 {
  return {
    version: 3,
    reference: "",
    currentFocus: "Reminder coordinator",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: new Date(NOW_MS).toISOString(),
    legacyImportedAt: null,
    references: [],
    phases: occurrences.map((item, index) => {
      const occurrenceKey = item.occurrenceKey ?? `occurrence-${item.phaseId}`;
      return {
        id: item.phaseId,
        title: `Phase ${item.phaseId}`,
        goal: "Deliver once",
        doneWhen: ["Delivery is durable"],
        order: item.order ?? index,
        status: item.status ?? "in-progress",
        sourcePrompt: "Private prompt",
        referenceIds: [],
        session: { sessionId: `session-${item.phaseId}`, sessionPath: `/sessions/${item.phaseId}` },
        reminder: {
          id: item.reminderId ?? `reminder-${item.phaseId}`,
          occurrenceKey,
          dueAt: item.dueAt,
          note: `Private note ${item.phaseId}`,
          createdAt: new Date(NOW_MS - 60_000).toISOString(),
          lastDelivery: item.delivered
            ? {
                occurrenceKey,
                attemptedAt: new Date(NOW_MS - 1_000).toISOString(),
                channel: "native",
                permission: "granted",
              }
            : null,
        },
        attentionReason: null,
        createdAt: new Date(NOW_MS - 120_000).toISOString(),
        updatedAt: new Date(NOW_MS - 60_000).toISOString(),
        completedAt:
          item.status === "done" || item.status === "cancelled"
            ? new Date(NOW_MS - 60_000).toISOString()
            : null,
        archivedAt: item.archivedAt ?? null,
        overrides: { status: null, referenceIds: null },
        lifecycleEvents: [],
        roadmapEvents: [],
      };
    }),
  };
}

class FakeClock implements ReminderClock {
  current = NOW_MS;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.current;
  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.current + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (let pass = 0; pass < 20; pass += 1) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at);
      if (due.length === 0) break;
      for (const [id, task] of due) {
        this.tasks.delete(id);
        task.callback();
      }
      await flushAsync();
    }
    await flushAsync();
  }

  pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.at - this.current).sort((a, b) => a - b);
  }
}

class FakeRepository {
  snapshot: ProjectNotesSnapshot;
  claims: ProjectNotesReminderDeliveryRequest[] = [];
  failClaim = false;

  constructor(document = notes(), cwd = PROJECT) {
    this.snapshot = { projectKey: canonicalProjectKey(cwd), revision: 1, document };
  }

  async load(): Promise<{
    status: "ok";
    snapshot: ProjectNotesSnapshot;
    recoveredFromBackup: false;
  }> {
    return { status: "ok", snapshot: structuredClone(this.snapshot), recoveredFromBackup: false };
  }

  async recordReminderDelivery(_cwd: string, request: ProjectNotesReminderDeliveryRequest) {
    if (this.failClaim) throw new Error("storage offline");
    this.claims.push(request);
    const document = structuredClone(this.snapshot.document);
    const phase = document.phases.find((candidate) => candidate.id === request.phaseId)!;
    if (phase.reminder?.occurrenceKey !== request.occurrenceKey) {
      return { status: "stale-occurrence" as const };
    }
    if (phase.reminder.lastDelivery?.occurrenceKey === request.occurrenceKey) {
      return { status: "already-delivered" as const };
    }
    phase.reminder.lastDelivery = {
      occurrenceKey: request.occurrenceKey,
      attemptedAt: request.attemptedAt,
      channel: request.channel,
      permission: request.permission,
    };
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      document,
    };
    return {
      status: "ok" as const,
      snapshot: structuredClone(this.snapshot),
      phase: structuredClone(phase),
    };
  }
}

function session(id: string, cwd = PROJECT): AppSidecarReminderSession {
  return { id, cwd };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("reminder due selection", () => {
  it("chooses the earliest active non-archived undelivered occurrence deterministically", () => {
    const document = notes([
      { phaseId: "later", dueAt: new Date(NOW_MS - 1_000).toISOString(), order: 0 },
      { phaseId: "first", dueAt: new Date(NOW_MS - 5_000).toISOString(), order: 2 },
      { phaseId: "delivered", dueAt: new Date(NOW_MS - 10_000).toISOString(), delivered: true },
      { phaseId: "done", dueAt: new Date(NOW_MS - 20_000).toISOString(), status: "done" },
      {
        phaseId: "archived",
        dueAt: new Date(NOW_MS - 30_000).toISOString(),
        archivedAt: new Date(NOW_MS).toISOString(),
      },
    ]);

    expect(selectDueReminder(document, NOW_MS)).toMatchObject({
      phase: { id: "first" },
      reminder: { occurrenceKey: "occurrence-first" },
    });
    expect(
      selectDueReminder(
        notes([{ phaseId: "future", dueAt: new Date(NOW_MS + 1).toISOString() }]),
        NOW_MS,
      ),
    ).toBeNull();
  });
});

describe("AppSidecarReminderCoordinator", () => {
  it("treats a same-key fixture as one project-global lease namespace", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository(
      notes([
        {
          phaseId: "first",
          dueAt: new Date(NOW_MS - 2_000).toISOString(),
          occurrenceKey: "shared-occurrence",
        },
        {
          phaseId: "second",
          dueAt: new Date(NOW_MS - 1_000).toISOString(),
          occurrenceKey: "shared-occurrence",
        },
      ]),
    );
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      createToken: () => "shared-lease",
    });
    const focused = session("focused");
    await coordinator.watchSession(focused);

    await expect(coordinator.reserve(focused, true)).resolves.toMatchObject({
      status: "reserved",
      leaseToken: "shared-lease",
      phase: { id: "first" },
      reminder: { occurrenceKey: "shared-occurrence" },
    });
    await expect(coordinator.reserve(focused, true)).resolves.toEqual({ status: "leased" });
    coordinator.dispose();
  });

  it("recovers one startup-overdue event and caps future waits for clock changes", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository();
    const due: string[] = [];
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: (projectKey) => due.push(projectKey),
      maxTimerDelayMs: 30_000,
    });

    await coordinator.watchSession(session("focused"));
    expect(clock.pendingDelays()).toEqual([0]);
    await clock.advance(0);
    expect(due).toEqual([canonicalProjectKey(PROJECT)]);
    expect(clock.pendingDelays()).toEqual([30_000]);
    await clock.advance(30_000);
    expect(due).toHaveLength(1);
    coordinator.dispose();
  });

  it("wakes at a future due time and stops all project state after the final session closes", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository(
      notes([{ phaseId: "future", dueAt: new Date(NOW_MS + 20_000).toISOString() }]),
    );
    const due: string[] = [];
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: (key) => due.push(key),
    });
    await coordinator.watchSession(session("one"));
    await coordinator.watchSession(session("two"));

    await clock.advance(19_999);
    expect(due).toEqual([]);
    await clock.advance(1);
    expect(due).toHaveLength(1);
    coordinator.unwatchSession("one");
    expect(clock.pendingDelays().length).toBeGreaterThan(0);
    coordinator.unwatchSession("two");
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("lets a focused same-project pane beat background grace and commits one claim", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository();
    const committed: ProjectNotesSnapshot[] = [];
    let token = 0;
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      onCommitted: (snapshot) => committed.push(snapshot),
      createToken: () => `lease-${++token}`,
    });
    const background = session("background");
    const focused = session("focused");
    await coordinator.watchSession(background);
    await coordinator.watchSession(focused);

    await expect(coordinator.reserve(background, false)).resolves.toEqual({
      status: "deferred",
      retryAt: new Date(NOW_MS + 750).toISOString(),
    });
    const reserved = await coordinator.reserve(focused, true);
    expect(reserved).toMatchObject({
      status: "reserved",
      leaseToken: "lease-1",
      phase: { id: "phase-1", title: "Phase phase-1" },
      reminder: {
        occurrenceKey: "occurrence-phase-1",
        note: "Private note phase-1",
      },
    });
    await expect(coordinator.reserve(background, false)).resolves.toEqual({ status: "leased" });
    await expect(
      coordinator.claim(background, "lease-1", { channel: "native", permission: "granted" }),
    ).resolves.toEqual({ status: "wrong-session" });
    await expect(
      coordinator.claim(focused, "lease-1", {
        channel: "in-app-fallback",
        permission: "denied",
      }),
    ).resolves.toMatchObject({ status: "ok", snapshot: { revision: 2 } });
    expect(repository.claims).toEqual([
      expect.objectContaining({
        phaseId: "phase-1",
        occurrenceKey: "occurrence-phase-1",
        channel: "in-app-fallback",
        permission: "denied",
      }),
    ]);
    expect(committed).toHaveLength(1);
    await expect(coordinator.reserve(background, false)).resolves.toEqual({
      status: "already-delivered",
    });
  });

  it("allows one background lease after grace, expires it, and clears session-owned leases", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository();
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      createToken: () => "expiring",
      leaseTtlMs: 1_000,
    });
    const background = session("background");
    await coordinator.watchSession(background);
    await coordinator.reserve(background, false);
    await clock.advance(750);
    const reserved = await coordinator.reserve(background, false);
    expect(reserved).toMatchObject({ status: "reserved", leaseToken: "expiring" });
    await clock.advance(1_000);
    await expect(
      coordinator.claim(background, "expiring", { channel: "native", permission: "granted" }),
    ).resolves.toEqual({ status: "expired-lease" });

    const replacement = await coordinator.reserve(background, true);
    expect(replacement).toMatchObject({ status: "reserved" });
    coordinator.unwatchSession("background");
    await expect(
      coordinator.claim(background, "expiring", { channel: "native", permission: "granted" }),
    ).resolves.toEqual({ status: "invalid-lease" });
  });

  it("releases a failed storage claim so another same-project session can retry", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository();
    repository.failClaim = true;
    let token = 0;
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      createToken: () => `retry-${++token}`,
    });
    const first = session("first");
    const second = session("second", "c:/work/./reminder");
    await coordinator.watchSession(first);
    await coordinator.watchSession(second);
    const reserved = await coordinator.reserve(first, true);
    expect(reserved).toMatchObject({ status: "reserved", leaseToken: "retry-1" });
    await expect(
      coordinator.claim(first, "retry-1", { channel: "in-app", permission: "not-required" }),
    ).rejects.toThrow("storage offline");

    repository.failClaim = false;
    await expect(coordinator.reserve(second, true)).resolves.toMatchObject({
      status: "reserved",
      leaseToken: "retry-2",
    });
    await expect(coordinator.release(second, "retry-2")).toEqual({ status: "released" });
  });

  it("keeps different projects independent", async () => {
    const clock = new FakeClock();
    const firstRepository = new FakeRepository(notes(), "C:/work/one");
    const secondSnapshot: ProjectNotesSnapshot = {
      projectKey: canonicalProjectKey("C:/work/two"),
      revision: 1,
      document: notes(),
    };
    const repository = {
      load: async (cwd: string) => ({
        status: "ok" as const,
        snapshot:
          canonicalProjectKey(cwd) === firstRepository.snapshot.projectKey
            ? structuredClone(firstRepository.snapshot)
            : structuredClone(secondSnapshot),
        recoveredFromBackup: false as const,
      }),
      recordReminderDelivery: firstRepository.recordReminderDelivery.bind(firstRepository),
    };
    let token = 0;
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      createToken: () => `independent-${++token}`,
    });
    const one = session("one", "C:/work/one");
    const two = session("two", "C:/work/two");
    await coordinator.watchSession(one);
    await coordinator.watchSession(two);
    await expect(coordinator.reserve(one, true)).resolves.toMatchObject({ status: "reserved" });
    await expect(coordinator.reserve(two, true)).resolves.toMatchObject({ status: "reserved" });
  });
});

describe("app sidecar reminder routes", () => {
  it("authenticates through the supplied logical session and rejects ambiguous bodies", async () => {
    const clock = new FakeClock();
    const repository = new FakeRepository();
    const coordinator = new AppSidecarReminderCoordinator({
      repository,
      clock,
      onReminderDue: () => {},
      createToken: () => "route-lease",
    });
    const logicalSession = session("route-session");
    await coordinator.watchSession(logicalSession);
    const handler = createAppSidecarReminderHandler(coordinator);
    const server = http.createServer((req, res) => {
      const authenticated = req.headers["x-session"] === logicalSession.id;
      if (!authenticated) {
        res.writeHead(404).end();
        return;
      }
      if (!handler.handle(req, res, logicalSession, req.url ?? "/", req.method ?? "GET")) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const invalid = await fetch(`${base}/reminders/reserve`, {
        method: "POST",
        headers: { "x-session": logicalSession.id, "content-type": "application/json" },
        body: JSON.stringify({ focused: true, extra: true }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ status: "invalid" });

      const reserve = await fetch(`${base}/reminders/reserve`, {
        method: "POST",
        headers: { "x-session": logicalSession.id, "content-type": "application/json" },
        body: JSON.stringify({ focused: true }),
      });
      await expect(reserve.json()).resolves.toMatchObject({
        status: "reserved",
        leaseToken: "route-lease",
      });

      const impossibleClaim = await fetch(`${base}/reminders/claim`, {
        method: "POST",
        headers: { "x-session": logicalSession.id, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: "route-lease",
          channel: "native",
          permission: "denied",
        }),
      });
      expect(impossibleClaim.status).toBe(400);
      await expect(impossibleClaim.json()).resolves.toMatchObject({ status: "invalid" });

      const claim = await fetch(`${base}/reminders/claim`, {
        method: "POST",
        headers: { "x-session": logicalSession.id, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: "route-lease",
          channel: "in-app-fallback",
          permission: "unavailable",
        }),
      });
      await expect(claim.json()).resolves.toMatchObject({
        status: "ok",
        snapshot: { revision: 2 },
      });
    } finally {
      coordinator.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
