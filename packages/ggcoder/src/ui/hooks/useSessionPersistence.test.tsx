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
  model,
  onPersisted,
}: {
  manager: SessionManager;
  cwd: string;
  model: string;
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
    currentModel: model,
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
  it("keeps Astra Fast and its context profile when the TUI compacts a session", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "gg-session-persistence-"));
    tempDirs.push(sessionsDir);
    const manager = new SessionManager(sessionsDir);
    const source = await manager.create("/repo", "openai", "gpt-6-astra-fast");
    const resumed = await manager.load(source.path);
    let checkpointPath: string | undefined;
    const mounted = render(
      <Harness
        manager={manager}
        cwd="/repo"
        model={resumed.header.model}
        onPersisted={(value) => (checkpointPath = value)}
      />,
      { patchConsole: false },
    );

    await vi.waitFor(() => expect(checkpointPath).toBeDefined());
    mounted.unmount();
    const checkpoint = await manager.load(checkpointPath!);
    expect(checkpoint.header.openAICodexContextProfile).toBe("experimental");
    expect(checkpoint.header.model).toBe("gpt-6-astra-fast");
    expect(checkpoint.header).not.toHaveProperty("openAICodexFast");
  });
});
