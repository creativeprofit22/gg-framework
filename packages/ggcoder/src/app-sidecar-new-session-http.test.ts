import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopSessionUXState } from "@kenkaiiii/gg-core/desktop-session-ux";
import { expect, expectTypeOf, it } from "vitest";
import type { SessionManager } from "./core/session-manager.js";
import { hashPlanContent, type PersistedPlanReviewCheckpoint } from "./app-sidecar-plan-gate.js";
import { withRealSidecar, type FixtureSessions } from "./test-support/real-sidecar.js";

expectTypeOf<SessionManager>().toMatchTypeOf<FixtureSessions>();

it.each(["stable", "experimental"] as const)("real reset receipts, pane isolation and rejected checkpoint (%s)", async (profile) => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: profile });
    const pane = await open(saved.path);
    const secondSaved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: profile });
    const other = await open(secondSaved.path);
    const state = async (id: string) => {
      const response = await request("/state", id);
      expect(response.status).toBe(200);
      return await response.json() as DesktopSessionUXState & { conversationId: string; sessionId: string; openAICodexContextProfile: string; pendingPlanReview?: unknown };
    };
    const original = await state(pane);
    expect(original.openAICodexContextProfile).toBe(profile);
    const otherOriginal = await state(other);
    expect(otherOriginal.lastNewSessionReset).toBeUndefined();
    const stream = await subscribe(pane);
    let previous = original;
    let first: DesktopSessionUXState["lastNewSessionReset"];
    for (let count = 1; count <= 2; count++) {
      const filesBefore = await manager.list(project);
      const response = await request("/new-session", pane, {});
      expect(response.status).toBe(200);
      const body = await response.json() as { operationId: string };
      expect(body.operationId).toEqual(expect.any(String));
      const current = await state(pane);
      expect(current.lastNewSessionReset).toEqual({ operationId: body.operationId,
        conversationId: current.conversationId, sessionId: current.sessionId });
      expect(current.conversationId).not.toBe(previous.conversationId);
      expect(current.sessionId).not.toBe(previous.sessionId);
      expect(current.openAICodexContextProfile).toBe(profile);
      const filesAfter = await manager.list(project);
      expect(filesAfter.filter((file) => !filesBefore.some((old) => old.id === file.id))).toHaveLength(1);
      expect(filesAfter).toHaveLength(filesBefore.length + 1);
      const event = await stream.waitFor("session_reset", count);
      expect(event.sessionId).toBe(pane);
      expect(event.data).toMatchObject({ ...current.lastNewSessionReset, kind: "new-session" });
      const otherCurrent = await state(other);
      expect(otherCurrent.lastNewSessionReset).toBeUndefined();
      expect(otherCurrent.conversationId).toBe(otherOriginal.conversationId);
      expect(otherCurrent.sessionId).toBe(otherOriginal.sessionId);
      if (first) {
        expect(current.lastNewSessionReset?.operationId).not.toBe(first.operationId);
        expect(current.lastNewSessionReset).not.toEqual(first);
        expect(first.conversationId).not.toBe(current.conversationId);
        expect(first.sessionId).not.toBe(current.sessionId);
      } else first = current.lastNewSessionReset;
      previous = current;
    }
    expect(stream.events.filter((event) => event.type === "session_reset")).toHaveLength(2);

    const blocked = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: profile });
    const content = "# Fixture plan\n\n## Steps\n\n1. Verify reset.";
    const checkpoint: PersistedPlanReviewCheckpoint = {
      version: 1, checkpointId: randomUUID(), generation: 1,
      planPath: path.join(project, ".gg", "plans", "fixture.md"), content,
      contentHash: hashPlanContent(content), state: "pending-review", reviewStatus: "unreviewed",
      actor: "gg-coder", timestamp: new Date().toISOString(), feedback: null,
    };
    await manager.appendRequiredEntry(blocked.path, { type: "custom", id: randomUUID(), parentId: null,
      timestamp: checkpoint.timestamp, kind: "app_transcript_marker",
      data: { version: 1, kind: "plan_gate", afterMessageCount: 0, data: checkpoint } });
    const blockedPane = await open(blocked.path);
    const blockedStream = await subscribe(blockedPane);
    const before = await state(blockedPane);
    expect(before.pendingPlanReview).toMatchObject({ checkpointId: checkpoint.checkpointId });
    const filesBefore = await manager.list(project);
    const bytesBefore = await Promise.all(filesBefore.map((file) => fs.readFile(file.path)));
    const rejected = await request("/new-session", blockedPane, {});
    expect(rejected.status).toBe(409);
    const after = await state(blockedPane);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.lastNewSessionReset).toBeUndefined();
    expect(await manager.list(project)).toEqual(filesBefore);
    expect(await Promise.all(filesBefore.map((file) => fs.readFile(file.path)))).toEqual(bytesBefore);
    // A fresh ready frame is an SSE barrier after the rejected route completes.
    await subscribe(blockedPane);
    expect(blockedStream.events.filter((event) => event.type === "session_reset")).toEqual([]);
  });
}, 90_000);
