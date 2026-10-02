import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateNotesDocumentV3 } from "@kenkaiiii/gg-core/project-notes";
import { ProjectNotesRepository } from "./project-notes-repository.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("explicit completion independent of run settlement", () => {
  it("preserves an unfinished second phase and persists Done before any run ends", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-direct-status-"));
    roots.push(root);
    const repository = new ProjectNotesRepository(root);
    const parsed = validateNotesDocumentV3(
      JSON.parse(
        await fs.readFile(
          new URL("../../../fixtures/project-notes-v3.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const document = parsed.document;
    const phase = document.phases[0]!;
    phase.status = "in-progress";
    phase.attentionReason = null;
    phase.overrides.status = null;
    phase.pendingAutomaticLifecycleTransition = null;
    phase.roadmapEvents = [];
    phase.reminder = null;
    phase.lifecycleEvents = [];
    const second = structuredClone(phase);
    second.id = "untouched-phase";
    second.order = 1;
    document.phases = [phase, second];
    const initial = await repository.migrate(root, document);
    if (initial.status === "invalid")
      throw new Error(`${initial.error.path}: ${initial.error.message}`);
    expect(initial).toMatchObject({ status: "ok" });
    const request = {
      updateId: "explicit-done",
      phaseId: phase.id,
      expectedRevision: 1,
      actor: "gg-coder" as const,
      transition: "done" as const,
      progress: "Reviewed requirements and documented unavailable checks",
      verification: "passed" as const,
      evidence: ["Inspected the required documentation sections"],
      blocker: null,
      requiredExternalAction: null,
      verificationReason: null,
      proposedReferences: [],
      timestamp: "2026-09-07T00:00:00.000Z",
      autopilotEnabled: false,
    };
    const result = await repository.recordRoadmapStatusUpdate(root, request);
    expect(result).toMatchObject({
      status: "committed",
      statusOutcome: "applied",
      phase: { status: "done" },
    });
    const reopened = await new ProjectNotesRepository(root).load(root);
    if (reopened.status !== "ok") throw new Error("Expected persisted Notes");
    expect(reopened.snapshot.document.phases[0]?.status).toBe("done");
    expect(reopened.snapshot.document.phases[1]).toEqual(second);
    expect(reopened.snapshot.document.phases[0]?.roadmapEvents.map((event) => event.type)).toEqual([
      "status-update",
    ]);
    expect(await repository.recordRoadmapStatusUpdate(root, request)).toMatchObject({
      status: "duplicate",
      statusOutcome: "applied",
    });
  });

  it("does not invoke settlement or verification follow-ups in daemon/session paths", async () => {
    const daemon = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const session = await fs.readFile(new URL("./core/agent-session.ts", import.meta.url), "utf8");
    const terminal = await fs.readFile(new URL("./ui/App.tsx", import.meta.url), "utf8");
    expect(daemon).not.toMatch(
      /finalizeAppSidecarCompletionIntents|roadmapCompletionIntents|settleDurableRun/,
    );
    expect(daemon).not.toContain("process.env.GG_ROADMAP_DURABLE_EXECUTION");
    expect(session).not.toMatch(
      /VerificationIncompleteError|buildActivePhaseVerificationFollowUp|verificationGate/,
    );
    expect(terminal).not.toMatch(/verificationGate|followUpNudgesRef/);
  });
});
