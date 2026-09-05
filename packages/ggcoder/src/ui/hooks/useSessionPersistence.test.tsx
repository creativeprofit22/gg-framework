import React, { useEffect, useRef } from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { SessionManager, type TurnMetricPayload } from "../../core/session-manager.js";
import type { SessionStats } from "../session-summary.js";
import { useSessionPersistence } from "./useSessionPersistence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function Harness({
  manager,
  cwd,
  onPersisted,
}: {
  manager: SessionManager;
  cwd: string;
  onPersisted: (path: string) => void;
}) {
  const sessionManagerRef = useRef<SessionManager | null>(manager);
  const sessionPathRef = useRef<string | undefined>(undefined);
  const sessionStatsRef = useRef({} as SessionStats);
  const persistedIndexRef = useRef(0);
  const messagesRef = useRef<Message[]>([
    { role: "system", content: "system" },
    { role: "user", content: "before compaction" },
  ]);
  const turnMetricsRef = useRef<TurnMetricPayload[]>([]);
  const cwdRef = useRef(cwd);
  const startedRef = useRef(false);
  const { persistCompactedSession } = useSessionPersistence({
    sessionManagerRef,
    sessionPathRef,
    sessionStatsRef,
    persistedIndexRef,
    messagesRef,
    turnMetricsRef,
    cwdRef,
    currentProvider: "openai",
    currentModel: "gpt-6-astra",
    openAICodexContextProfile: "experimental",
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void persistCompactedSession([
      { role: "system", content: "system" },
      { role: "user", content: "compacted summary" },
    ]).then(() => onPersisted(sessionPathRef.current!));
  }, [onPersisted, persistCompactedSession, sessionPathRef]);

  return null;
}

describe("useSessionPersistence", () => {
  it("retains the experimental Codex profile in compacted checkpoints", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "gg-session-persistence-"));
    tempDirs.push(sessionsDir);
    const manager = new SessionManager(sessionsDir);
    let checkpointPath: string | undefined;
    const mounted = render(
      <Harness manager={manager} cwd="/repo" onPersisted={(value) => (checkpointPath = value)} />,
      { patchConsole: false },
    );

    await vi.waitFor(() => expect(checkpointPath).toBeDefined());
    mounted.unmount();
    expect((await manager.load(checkpointPath!)).header.openAICodexContextProfile).toBe(
      "experimental",
    );
  });
});
