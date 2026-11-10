import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NotesDocumentV3,
  NotesPhase,
  NotesSessionLink,
  ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import {
  checkAgentPhaseStart,
  isAgentPhaseAttachAction,
} from "./app-sidecar-agent-phase-start-gate.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";

const { completionCompatibilityFixture } = (await import(
  new URL(
    "../../gg-core/src/test-fixtures/project-notes-completion-compatibility.ts",
    import.meta.url,
  ).href
)) as { completionCompatibilityFixture(): Promise<NotesDocumentV3> };

const USER_SESSION: NotesSessionLink = { sessionId: "user-start", sessionPath: "/s/user.jsonl" };
const OTHER_SESSION: NotesSessionLink = { sessionId: "other", sessionPath: "/s/other.jsonl" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Phases A, B, C not started; C depends on A. */
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-agent-start-gate-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const document = await completionCompatibilityFixture();
  const template = document.phases[2]!;
  document.phases = ["a", "b", "c"].map((key, order) => ({
    ...structuredClone(template),
    id: `phase-${key}`,
    title: `Phase ${key.toUpperCase()}`,
    order,
    status: "not-started" as const,
    completedAt: null,
    session: null,
    reminder: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  }));
  const migrated = await repository.migrate(cwd, document);
  if (migrated.status !== "ok") throw Error(JSON.stringify(migrated));
  const linked = structuredClone(migrated.snapshot.document);
  linked.phases.find((phase) => phase.id === "phase-c")!.dependsOn = ["phase-a"];
  const saved = await repository.save(cwd, migrated.snapshot.revision, linked);
  if (saved.status !== "ok") throw Error(JSON.stringify(saved));
  return { cwd, repository };
}

async function userStart(repository: ProjectNotesRepository, cwd: string) {
  const launched = await repository.launchPhase(cwd, "phase-c", async () => USER_SESSION, {
    confirmedPrerequisiteIds: ["phase-a"],
  });
  if (launched.status !== "accepted") throw Error(JSON.stringify(launched));
  return launched.snapshot;
}

/** A read-only stand-in returning an edited copy of a real snapshot. */
function loadingWith(snapshot: ProjectNotesSnapshot, edit: (phase: NotesPhase) => void) {
  const changed = structuredClone(snapshot);
  edit(changed.document.phases.find((phase) => phase.id === "phase-c")!);
  return {
    load: async () => ({ status: "ok" as const, snapshot: changed, recoveredFromBackup: false }),
  };
}

describe("agent phase start gate", () => {
  it("refuses bind, acquire or takeover of a phase with unfinished prerequisites", async () => {
    const { cwd, repository } = await setup();
    const refusal = await checkAgentPhaseStart(repository, cwd, "phase-c", OTHER_SESSION, "attach");
    expect(refusal).toEqual({
      status: "prerequisites-unfinished",
      phaseId: "phase-c",
      prerequisites: [{ id: "phase-a", title: "Phase A", status: "not-started" }],
      message: `Can't start "Phase C" (phase-c): these prerequisite phases aren't Done: "Phase A" (phase-a). The user can start it from the app.`,
    });
    expect(await checkAgentPhaseStart(repository, cwd, "phase-b", OTHER_SESSION, "attach")).toBe(
      null,
    );
    for (const action of ["bind-current", "rebind-current", "acquire", "takeover"]) {
      expect(isAgentPhaseAttachAction(action)).toBe(true);
    }
    for (const action of ["inspect", "renew", "release"]) {
      expect(isAgentPhaseAttachAction(action)).toBe(false);
    }
  });

  it("allows the session the user started from the app, and only that session", async () => {
    const { cwd, repository } = await setup();
    const started = await userStart(repository, cwd);
    const override = started.document.phases
      .find((phase) => phase.id === "phase-c")!
      .roadmapEvents.filter((event) => event.type === "dependency-override");
    expect(override).toMatchObject([
      {
        actor: "user",
        origin: "app",
        session: USER_SESSION,
        unfinishedPrerequisiteIds: ["phase-a"],
      },
    ]);
    expect(await checkAgentPhaseStart(repository, cwd, "phase-c", USER_SESSION, "attach")).toBe(
      null,
    );
    expect(
      await checkAgentPhaseStart(repository, cwd, "phase-c", OTHER_SESSION, "attach"),
    ).toMatchObject({ status: "prerequisites-unfinished" });
  });

  it("refuses after an autopilot start, a reopen or a rebind", async () => {
    const { cwd, repository } = await setup();
    const started = await userStart(repository, cwd);
    // Not active here, so only the override could allow the start.
    const variants: ((phase: NotesPhase) => void)[] = [
      (phase) => {
        const event = phase.roadmapEvents.at(-1)!;
        if (event.type === "dependency-override") event.actor = "ken-autopilot";
        phase.status = "not-started";
      },
      (phase) => {
        phase.lifecycleEvents.push({
          id: "reopen",
          fromStatus: "done",
          toStatus: "not-started",
          source: "user",
          timestamp: "2099-01-01T00:00:00.000Z",
          reason: "Reopened",
          kind: "other",
        });
        phase.status = "not-started";
      },
      (phase) => {
        phase.roadmapEvents.push({
          type: "phase-binding",
        } as unknown as NotesPhase["roadmapEvents"][number]);
        phase.session = { ...OTHER_SESSION };
      },
    ];
    for (const edit of variants) {
      const refusal = await checkAgentPhaseStart(
        loadingWith(started, edit),
        cwd,
        "phase-c",
        USER_SESSION,
        "attach",
      );
      expect(refusal).toMatchObject({ status: "prerequisites-unfinished" });
    }
  });

  it("lets status updates and attaches continue a phase already active in this session", async () => {
    const { cwd, repository } = await setup();
    const started = await userStart(repository, cwd);
    const withoutOverride = loadingWith(started, (phase) => {
      phase.roadmapEvents = phase.roadmapEvents.filter(
        (event) => event.type !== "dependency-override",
      );
    });
    expect(
      await checkAgentPhaseStart(withoutOverride, cwd, "phase-c", USER_SESSION, "status"),
    ).toBe(null);
    expect(
      await checkAgentPhaseStart(withoutOverride, cwd, "phase-c", OTHER_SESSION, "status"),
    ).toMatchObject({ status: "prerequisites-unfinished" });
    expect(
      await checkAgentPhaseStart(withoutOverride, cwd, "phase-c", USER_SESSION, "attach"),
    ).toBe(null);
    expect(
      await checkAgentPhaseStart(withoutOverride, cwd, "phase-c", OTHER_SESSION, "attach"),
    ).toMatchObject({ status: "prerequisites-unfinished" });
    const notActive = loadingWith(started, (phase) => {
      phase.roadmapEvents = phase.roadmapEvents.filter(
        (event) => event.type !== "dependency-override",
      );
      phase.status = "not-started";
    });
    expect(
      await checkAgentPhaseStart(notActive, cwd, "phase-c", USER_SESSION, "attach"),
    ).toMatchObject({ status: "prerequisites-unfinished" });
  });

  it("lets the same conversation re-attach after compaction moves the phase link", async () => {
    const { cwd, repository } = await setup();
    await userStart(repository, cwd);
    const compacted: NotesSessionLink = {
      sessionId: "user-start-compacted",
      sessionPath: "/s/user-compacted.jsonl",
    };
    const moved = await repository.updatePhaseSessionLink(cwd, "phase-c", compacted, USER_SESSION);
    if (moved.status !== "ok") throw Error(JSON.stringify(moved));
    const phase = moved.snapshot.document.phases.find((candidate) => candidate.id === "phase-c")!;
    expect(phase.session).toEqual(compacted);
    expect(phase.roadmapEvents.find((event) => event.type === "dependency-override")).toMatchObject(
      { session: USER_SESSION },
    );
    const inProgress = loadingWith(moved.snapshot, (candidate) => {
      candidate.status = "in-progress";
    });
    for (const source of [repository, inProgress]) {
      expect(await checkAgentPhaseStart(source, cwd, "phase-c", compacted, "attach")).toBe(null);
      for (const other of [OTHER_SESSION, USER_SESSION]) {
        expect(await checkAgentPhaseStart(source, cwd, "phase-c", other, "attach")).toMatchObject({
          status: "prerequisites-unfinished",
        });
      }
    }
  });
});
