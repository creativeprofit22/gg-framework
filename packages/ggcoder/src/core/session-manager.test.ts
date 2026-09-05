import fs, {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  readdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionManager,
  RequiredSessionPersistenceError,
  syncRequiredPromptForDurability,
  KEN_TURN_CUSTOM_KIND,
  AUTOPILOT_MARKER_CUSTOM_KIND,
  APP_MARKER_CUSTOM_KIND,
  TURN_METRIC_CUSTOM_KIND,
  APPROVED_PLAN_CONSUMPTION_CUSTOM_KIND,
  approvedPlanContentHash,
  type SessionEntry,
  type MessageEntry,
  type TurnMetricPayload,
  type CustomEntry,
} from "./session-manager.js";
import {
  ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
  ACTIVE_PHASE_CONTEXT_KIND,
  ROADMAP_PHASE_LEASE_KIND,
} from "../phase-context.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-session-manager-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function entry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hi" },
  };
}

describe("SessionManager context profiles", () => {
  it("round-trips an optional profile and keeps legacy headers compatible", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "openai", "gpt-6-astra", {
      openAICodexContextProfile: "experimental",
      openAICodexFast: true,
    });
    const restored = (await manager.load(session.path)).header;
    expect(restored.openAICodexContextProfile).toBe("experimental");
    expect(restored.openAICodexFast).toBe(true);

    const legacyPath = path.join(sessionsDir, "legacy.jsonl");
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        type: "session",
        version: 1,
        id: "legacy",
        timestamp: "2026-09-04T00:00:00.000Z",
        cwd: "/repo",
        provider: "openai",
        model: "gpt-6-astra",
      })}\n`,
      "utf-8",
    );
    const legacy = (await manager.load(legacyPath, { resolveCanonical: false })).header;
    expect(legacy.openAICodexContextProfile).toBeUndefined();
    expect(legacy.openAICodexFast).toBeUndefined();
  });

  it("preserves concurrent profile, Fast, and message writes", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "openai", "gpt-6-astra");

    await Promise.all([
      manager.updateOpenAICodexContextProfile(session.path, "experimental"),
      manager.updateOpenAICodexFast(session.path, true),
      manager.appendEntry(session.path, entry("parallel-append")),
    ]);

    const loaded = await manager.load(session.path);
    expect(loaded.header.openAICodexContextProfile).toBe("experimental");
    expect(loaded.header.openAICodexFast).toBe(true);
    expect(loaded.entries.map((item) => item.id)).toContain("parallel-append");
  });

  it("preserves an append racing a context profile rewrite", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "openai", "gpt-6-astra");
    const realReadFile = fs.readFile.bind(fs);
    const sessionPath = path.resolve(session.path);
    const lockPath = `${sessionPath}.lock`;
    let sessionReads = 0;
    let markProfileRead!: () => void;
    let releaseProfileRead!: () => void;
    let markAppendWaiting!: () => void;
    const profileRead = new Promise<void>((resolve) => {
      markProfileRead = resolve;
    });
    const profileReadRelease = new Promise<void>((resolve) => {
      releaseProfileRead = resolve;
    });
    const appendWaiting = new Promise<void>((resolve) => {
      markAppendWaiting = resolve;
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const content = await realReadFile(...args);
      const readPath = path.resolve(String(args[0]));
      if (readPath === sessionPath && ++sessionReads === 2) {
        markProfileRead();
        await profileReadRelease;
      } else if (readPath === lockPath) {
        markAppendWaiting();
      }
      return content;
    });

    const profileUpdate = manager.updateOpenAICodexContextProfile(session.path, "experimental");
    await profileRead;
    const append = manager.appendEntry(session.path, entry("concurrent-append"));
    const appendState = await Promise.race([
      append.then(() => "appended" as const),
      appendWaiting.then(() => "waiting" as const),
    ]);
    releaseProfileRead();
    await Promise.all([profileUpdate, append]);

    expect(appendState).toBe("waiting");
    const loaded = await manager.load(session.path);
    expect(loaded.header.openAICodexContextProfile).toBe("experimental");
    expect(loaded.entries.map((item) => item.id)).toContain("concurrent-append");
  });
});

describe("SessionManager redaction boundary", () => {
  it("persists sanitized clones for message and custom success/failure entries", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, "", "utf-8");
    const canary = "opaque-session-canary-value-123456";
    const previous = process.env.GG_SESSION_TEST_SECRET;
    process.env.GG_SESSION_TEST_SECRET = canary;
    const manager = new SessionManager(dir);
    const messageEntry: SessionEntry = {
      type: "message",
      id: "message",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: `use ${canary}` },
    };
    const customEntry: CustomEntry = {
      type: "custom",
      kind: "test_failure",
      id: "custom",
      parentId: null,
      timestamp: new Date().toISOString(),
      data: { error: `failed with ${canary}`, accessToken: canary },
    };

    try {
      await manager.appendEntry(file, messageEntry);
      await manager.appendEntry(file, customEntry);
    } finally {
      if (previous === undefined) delete process.env.GG_SESSION_TEST_SECRET;
      else process.env.GG_SESSION_TEST_SECRET = previous;
    }

    const persisted = await readFile(file, "utf-8");
    expect(persisted).not.toContain(canary);
    expect(persisted).toContain("[REDACTED]");
    expect(messageEntry.message.content).toContain(canary);
    expect(customEntry.data).toEqual({ error: `failed with ${canary}`, accessToken: canary });
  });
});

describe("SessionManager required phase markers", () => {
  it("durably persists active phase clear markers", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "anthropic", "test-model");
    await manager.appendRequiredEntry(session.path, {
      type: "custom",
      kind: ACTIVE_PHASE_CONTEXT_CLEAR_KIND,
      id: "clear-1",
      parentId: null,
      timestamp: "2026-08-30T10:00:00.000Z",
      data: {
        version: 1,
        projectKey: "/repo",
        phaseId: "phase-1",
        reason: "binding-compensation",
      },
    });
    expect(await readFile(session.path, "utf8")).toContain(ACTIVE_PHASE_CONTEXT_CLEAR_KIND);
  });

  it("durably restores strict Roadmap lease hints", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const session = await manager.create("/repo", "anthropic", "test-model");
    const marker = {
      version: 1 as const,
      projectKey: "/repo",
      phaseId: "phase-1",
      planId: "plan-1",
      planHash: "a".repeat(64),
      leaseId: "lease-1",
      fence: 2,
      daemonInstanceId: "daemon-1",
    };
    await manager.appendRequiredEntry(session.path, {
      type: "custom",
      kind: ROADMAP_PHASE_LEASE_KIND,
      id: "lease-marker-1",
      parentId: null,
      timestamp: "2026-08-30T10:00:00.000Z",
      data: marker,
    });
    const loaded = await manager.load(session.path);
    expect(manager.getRoadmapPhaseLeaseMarker(loaded.entries, { projectKey: "/repo" })).toEqual(
      marker,
    );
  });
});

describe("SessionManager conversation identity", () => {
  it("preserves checkpoint identity and a bounded display preview", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);

    const original = await manager.create("/repo", "anthropic", "test-model");
    const checkpoint = await manager.create("/repo", "anthropic", "test-model", {
      conversationId: original.header.conversationId,
      generation: 1,
      parentSessionId: original.id,
      preview: `  Original   request ${"x".repeat(100)}  `,
    });
    const loadedCheckpoint = await manager.load(checkpoint.path);

    expect(original.header.conversationId).toBe(original.id);
    expect(checkpoint.id).not.toBe(original.id);
    expect(checkpoint.header.conversationId).toBe(original.id);
    expect(loadedCheckpoint.header.conversationId).toBe(original.id);
    expect(loadedCheckpoint.header.preview).toBe(`Original request ${"x".repeat(63)}`);
  });

  it("canonicalizes stale physical ids and paths to the highest generation", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const original = await manager.create("/repo", "anthropic", "test-model");
    const first = await manager.create("/repo", "anthropic", "test-model", {
      conversationId: original.id,
      generation: 1,
      parentSessionId: original.id,
      sourceFingerprint: "a".repeat(64),
    });
    const newest = await manager.create("/repo", "anthropic", "test-model", {
      conversationId: original.id,
      generation: 2,
      parentSessionId: first.id,
      sourceFingerprint: "b".repeat(64),
    });
    await manager.appendEntry(newest.path, entry("latest-message"));

    // Generation wins even if an older checkpoint has a newer filesystem time.
    const future = new Date(Date.now() + 60_000);
    await utimes(first.path, future, future);

    expect(await manager.findById("/repo", original.id)).toBe(newest.path);
    expect(await manager.findById("/repo", first.id)).toBe(newest.path);
    expect(await manager.resolveCanonicalSession(original.path)).toBe(newest.path);
    expect((await manager.load(original.path)).header.id).toBe(newest.id);
    expect(await manager.getMostRecent("/repo")).toBe(newest.path);
  });

  it("loads ancestry oldest first and stops before corrupt or missing parents", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const original = await manager.create("/original-repo", "anthropic", "test-model");
    const first = await manager.create("/second-repo", "anthropic", "test-model", {
      conversationId: original.id,
      generation: 1,
      parentSessionId: original.id,
    });
    const newest = await manager.create("/third-repo", "anthropic", "test-model", {
      conversationId: original.id,
      generation: 2,
      parentSessionId: first.id,
    });

    expect(
      (await manager.loadCheckpointChain(original.path)).map((item) => item.header.id),
    ).toEqual([original.id, first.id, newest.id]);

    await writeFile(first.path, `${JSON.stringify(first.header)}\nnot-json\n`);
    expect((await manager.loadCheckpointChain(newest.path)).map((item) => item.header.id)).toEqual([
      newest.id,
    ]);

    await rm(first.path);
    expect((await manager.loadCheckpointChain(newest.path)).map((item) => item.header.id)).toEqual([
      newest.id,
    ]);
  });
});

describe("SessionManager compaction coordination", () => {
  it("serializes two independent managers for the same conversation", async () => {
    const sessionsDir = await makeTempDir();
    const firstManager = new SessionManager(sessionsDir);
    const secondManager = new SessionManager(sessionsDir);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = firstManager.withCompactionLease("conversation", undefined, async () => {
      order.push("first:start");
      firstStarted();
      await hold;
      order.push("first:end");
    });
    await started;
    const second = secondManager.withCompactionLease("conversation", undefined, async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("recovers a dead-owner lease and ignores coordination storage during discovery", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const conversationId = "dead-owner";
    const key = crypto.createHash("sha256").update(conversationId).digest("hex");
    const lockPath = path.join(sessionsDir, ".compaction-coordination", `${key}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: 2_147_483_647, createdAt: new Date().toISOString() }),
      "utf-8",
    );

    await expect(
      manager.withCompactionLease(conversationId, undefined, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(await manager.listAllSummaries()).toEqual([]);
  });

  it("recovers an old corrupt lease and round-trips attempt state", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const conversationId = "corrupt-owner";
    const key = crypto.createHash("sha256").update(conversationId).digest("hex");
    const lockPath = path.join(sessionsDir, ".compaction-coordination", `${key}.lock`);
    await mkdir(lockPath, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    await manager.withCompactionLease(conversationId, undefined, async () => undefined);
    const state = {
      fingerprint: "a".repeat(64),
      policyKey: "openai:model:0.85",
      outcome: "noop" as const,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await manager.writeCompactionAttemptState(conversationId, state);
    expect(await manager.readCompactionAttemptState(conversationId)).toEqual(state);
  });
});

describe("SessionManager persistence failure handling", () => {
  it("appendEntry does not throw when the write fails (e.g. disk full)", async () => {
    const manager = new SessionManager(await makeTempDir());
    const badPath = path.join("/nonexistent-gg-dir", "session.jsonl");

    const errors: NodeJS.ErrnoException[] = [];
    manager.onPersistError = (error) => errors.push(error);

    await expect(manager.appendEntry(badPath, entry("a"))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("ENOENT");
  });

  it("reports a persistence failure only once per error code", async () => {
    const manager = new SessionManager(await makeTempDir());
    const badPath = path.join("/nonexistent-gg-dir", "session.jsonl");

    let calls = 0;
    manager.onPersistError = () => {
      calls += 1;
    };

    await manager.appendEntry(badPath, entry("a"));
    await manager.appendEntry(badPath, entry("b"));
    await manager.updateLeaf(badPath, "leaf-1");
    expect(calls).toBe(1);
  });

  it("appendEntry seals a crash-torn last line instead of fusing onto it", async () => {
    const sessionsDir = await makeTempDir();
    const created = await new SessionManager(sessionsDir).create(
      sessionsDir,
      "anthropic",
      "test-model",
    );
    // A process killed mid-append: the JSON is cut off and has no newline.
    await appendFile(created.path, '{"type":"message","id":"torn","mess', "utf-8");

    // A fresh manager, as on resume after the crash.
    const resumed = new SessionManager(sessionsDir);
    await resumed.appendEntry(created.path, entry("after-crash"));

    const lines = (await readFile(created.path, "utf-8")).split("\n").filter(Boolean);
    // The torn record stays lost — it was never complete — but the record
    // written after it survives as its own parseable line.
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ type: "message", id: "after-crash" });
    const loaded = await resumed.load(created.path);
    expect(loaded?.entries.map((e) => e.id)).toEqual(["after-crash"]);
  });

  it("appendEntry leaves an intact file byte-identical apart from the new line", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create(sessionsDir, "anthropic", "test-model");
    const before = await readFile(created.path, "utf-8");

    await manager.appendEntry(created.path, entry("clean"));

    const after = await readFile(created.path, "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("appendEntry still writes normally when the disk is healthy", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create(sessionsDir, "anthropic", "test-model");

    await manager.appendEntry(created.path, entry("ok"));
    const content = await readFile(created.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ type: "message", id: "ok" });
  });

  it("treats only Windows EPERM fsync on the final read handle as unsupported", async () => {
    const unsupported = Object.assign(new Error("EPERM: operation not permitted, fsync"), {
      code: "EPERM",
      syscall: "fsync",
    });

    await expect(
      syncRequiredPromptForDurability(async () => {
        throw unsupported;
      }, "win32"),
    ).resolves.toBeUndefined();

    for (const [platform, code, syscall] of [
      ["win32", "EIO", "fsync"],
      ["win32", "EPERM", "write"],
      ["linux", "EPERM", "fsync"],
    ] as const) {
      const failure = Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
      await expect(
        syncRequiredPromptForDurability(async () => {
          throw failure;
        }, platform),
      ).rejects.toBe(failure);
    }
  });

  it("still surfaces a real required-prompt open failure", async () => {
    const manager = new SessionManager(await makeTempDir());
    const badPath = path.join("/nonexistent-required-prompt-dir", "session.jsonl");

    const failure = manager.appendRequiredMessage(badPath, entry("required") as MessageEntry);
    await expect(failure).rejects.toBeInstanceOf(RequiredSessionPersistenceError);
    await expect(failure).rejects.toMatchObject({ cause: { code: "ENOENT" } });
  });

  it("still surfaces a required-prompt write failure before the final fsync", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create(sessionsDir, "anthropic", "test-model");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[1] !== "a") return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return async () => {
              throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
                code: "ENOSPC",
                syscall: "write",
              });
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const failure = manager.appendRequiredMessage(
      created.path,
      entry("required-write") as MessageEntry,
    );
    await expect(failure).rejects.toBeInstanceOf(RequiredSessionPersistenceError);
    await expect(failure).rejects.toMatchObject({ cause: { code: "ENOSPC", syscall: "write" } });
  });
});

function kenEntry(id: string, data: unknown, kind: string = KEN_TURN_CUSTOM_KIND): CustomEntry {
  return { type: "custom", kind, id, parentId: null, timestamp: new Date().toISOString(), data };
}

describe("SessionManager.getKenTurns", () => {
  const manager = new SessionManager("/unused");

  it("reads valid Ken turns in file order", () => {
    const entries: SessionEntry[] = [
      kenEntry("k1", { version: 1, question: "what next?", reply: "do X", afterMessageCount: 0 }),
      entry("m1"),
      kenEntry("k2", { version: 1, question: "and now?", reply: "do Y", afterMessageCount: 1 }),
    ];
    const turns = manager.getKenTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ question: "what next?", reply: "do X", afterMessageCount: 0 });
    expect(turns[1]).toMatchObject({ question: "and now?", reply: "do Y", afterMessageCount: 1 });
  });

  it("ignores message entries and other custom kinds", () => {
    const entries: SessionEntry[] = [
      entry("m1"),
      kenEntry("d1", { version: 1, item: { kind: "x", id: "y" } }, "display_item"),
      kenEntry("k1", { version: 1, question: "q", reply: "r", afterMessageCount: 2 }),
    ];
    expect(manager.getKenTurns(entries)).toHaveLength(1);
  });

  it("drops malformed Ken payloads (missing fields / wrong version)", () => {
    const entries: SessionEntry[] = [
      kenEntry("k1", { version: 2, question: "q", reply: "r" }),
      kenEntry("k2", { version: 1, question: "q" }),
      kenEntry("k3", { version: 1, reply: "r" }),
      kenEntry("k4", null),
      kenEntry("k5", { version: 1, question: "ok", reply: "good", afterMessageCount: 3 }),
    ];
    const turns = manager.getKenTurns(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ question: "ok", reply: "good", afterMessageCount: 3 });
  });

  it("defaults a missing afterMessageCount to 0", () => {
    const turns = manager.getKenTurns([kenEntry("k1", { version: 1, question: "q", reply: "r" })]);
    expect(turns[0]?.afterMessageCount).toBe(0);
  });

  it("round-trips Ken turns through a written session file", async () => {
    const sessionsDir = await makeTempDir();
    const manager2 = new SessionManager(sessionsDir);
    const created = await manager2.create(sessionsDir, "anthropic", "test-model");
    await manager2.appendEntry(created.path, entry("m1"));
    await manager2.appendEntry(
      created.path,
      kenEntry("k1", {
        version: 1,
        question: "persist me",
        reply: "persisted",
        afterMessageCount: 1,
      }),
    );
    const loaded = await manager2.load(created.path);
    // The Ken turn must NOT appear in the LLM message history.
    const msgs = manager2.getMessages(loaded.entries, loaded.header.leafId);
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain("persist me");
    // But it must be readable as a Ken turn.
    const turns = manager2.getKenTurns(loaded.entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ question: "persist me", reply: "persisted" });
  });
});

function autopilotEntry(
  id: string,
  data: unknown,
  kind: string = AUTOPILOT_MARKER_CUSTOM_KIND,
): CustomEntry {
  return { type: "custom", kind, id, parentId: null, timestamp: new Date().toISOString(), data };
}

describe("SessionManager.getAutopilotMarkers", () => {
  const manager = new SessionManager("/unused");

  it("reads valid autopilot markers in file order", () => {
    const entries: SessionEntry[] = [
      autopilotEntry("a1", { version: 1, phase: "prompted", body: "fix X", afterMessageCount: 0 }),
      entry("m1"),
      autopilotEntry("a2", { version: 1, phase: "done", afterMessageCount: 1 }),
    ];
    const markers = manager.getAutopilotMarkers(entries);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ phase: "prompted", body: "fix X", afterMessageCount: 0 });
    expect(markers[1]).toMatchObject({ phase: "done", afterMessageCount: 1 });
  });

  it("ignores message entries and other custom kinds", () => {
    const entries: SessionEntry[] = [
      entry("m1"),
      autopilotEntry("d1", { version: 1, item: { kind: "x", id: "y" } }, "display_item"),
      autopilotEntry("k1", { version: 1, question: "q", reply: "r" }, KEN_TURN_CUSTOM_KIND),
      autopilotEntry("a1", {
        version: 1,
        phase: "human",
        reason: "ambiguous",
        afterMessageCount: 2,
      }),
    ];
    expect(manager.getAutopilotMarkers(entries)).toHaveLength(1);
  });

  it("drops malformed autopilot payloads (bad version / unknown phase)", () => {
    const entries: SessionEntry[] = [
      autopilotEntry("a1", { version: 2, phase: "done" }),
      autopilotEntry("a2", { version: 1, phase: "unknown" }),
      autopilotEntry("a3", { version: 1 }),
      autopilotEntry("a4", null),
      autopilotEntry("a5", { version: 1, phase: "capped", afterMessageCount: 3 }),
    ];
    const markers = manager.getAutopilotMarkers(entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ phase: "capped", afterMessageCount: 3 });
  });

  it("accepts the plan_approved phase (autopilot plan auto-accept)", () => {
    // Regression: the validator once whitelisted only the four original
    // phases, silently dropping persisted plan_approved markers on resume.
    const markers = manager.getAutopilotMarkers([
      autopilotEntry("a1", { version: 1, phase: "plan_approved", afterMessageCount: 0 }),
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ phase: "plan_approved", afterMessageCount: 0 });
  });

  it("defaults a missing afterMessageCount to 0", () => {
    const markers = manager.getAutopilotMarkers([
      autopilotEntry("a1", { version: 1, phase: "done" }),
    ]);
    expect(markers[0]?.afterMessageCount).toBe(0);
  });

  it("round-trips an autopilot marker through a written session file", async () => {
    const sessionsDir = await makeTempDir();
    const manager2 = new SessionManager(sessionsDir);
    const created = await manager2.create(sessionsDir, "anthropic", "test-model");
    await manager2.appendEntry(created.path, entry("m1"));
    await manager2.appendEntry(
      created.path,
      autopilotEntry("a1", {
        version: 1,
        phase: "human",
        reason: "needs a call",
        afterMessageCount: 1,
      }),
    );
    const loaded = await manager2.load(created.path);
    // The marker must NOT appear in the LLM message history.
    const msgs = manager2.getMessages(loaded.entries, loaded.header.leafId);
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain("needs a call");
    // But it must be readable as an autopilot marker.
    const markers = manager2.getAutopilotMarkers(loaded.entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ phase: "human", reason: "needs a call" });
  });
});

describe("SessionManager.getAppMarkers", () => {
  const manager = new SessionManager("/unused");

  it("reads valid app markers in file order, ignoring other kinds", () => {
    const entries: SessionEntry[] = [
      autopilotEntry(
        "p1",
        { version: 1, kind: "plan", afterMessageCount: 0, data: { reason: "big change" } },
        APP_MARKER_CUSTOM_KIND,
      ),
      entry("m1"),
      autopilotEntry("a1", { version: 1, phase: "done", afterMessageCount: 1 }),
      autopilotEntry(
        "e1",
        { version: 1, kind: "error", afterMessageCount: 1, data: { headline: "Rate limited" } },
        APP_MARKER_CUSTOM_KIND,
      ),
    ];
    const markers = manager.getAppMarkers(entries);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      kind: "plan",
      afterMessageCount: 0,
      data: { reason: "big change" },
    });
    expect(markers[1]).toMatchObject({ kind: "error", data: { headline: "Rate limited" } });
  });

  it("drops malformed payloads (bad version / unknown kind) and normalizes fields", () => {
    const markers = manager.getAppMarkers([
      autopilotEntry("b1", { version: 2, kind: "plan", data: {} }, APP_MARKER_CUSTOM_KIND),
      autopilotEntry("b2", { version: 1, kind: "nope", data: {} }, APP_MARKER_CUSTOM_KIND),
      autopilotEntry("b3", null, APP_MARKER_CUSTOM_KIND),
      // Missing afterMessageCount → 0; missing/null data → {}.
      autopilotEntry("ok", { version: 1, kind: "task", data: null }, APP_MARKER_CUSTOM_KIND),
    ]);
    expect(markers).toEqual([
      { version: 1, kind: "task", afterMessageCount: 0, data: {}, recordedAfterMessageCount: 0 },
    ]);
  });

  it("accepts the compaction kind (persisted N → M counts for the resumed notice)", () => {
    const markers = manager.getAppMarkers([
      autopilotEntry(
        "c1",
        {
          version: 1,
          kind: "compaction",
          afterMessageCount: 3,
          data: { originalCount: 40, newCount: 6 },
        },
        APP_MARKER_CUSTOM_KIND,
      ),
    ]);
    expect(markers).toEqual([
      {
        version: 1,
        kind: "compaction",
        afterMessageCount: 3,
        data: { originalCount: 40, newCount: 6 },
        // File-order position: no message entries precede it in this fixture.
        recordedAfterMessageCount: 0,
      },
    ]);
  });

  it("accepts the active-agent handoff marker used to restore resumed chats", () => {
    const markers = manager.getAppMarkers([
      autopilotEntry(
        "handoff-1",
        {
          version: 1,
          kind: "agent_handoff",
          afterMessageCount: 4,
          data: { chatAgent: "therapist" },
        },
        APP_MARKER_CUSTOM_KIND,
      ),
    ]);
    expect(markers).toEqual([
      {
        version: 1,
        kind: "agent_handoff",
        afterMessageCount: 4,
        data: { chatAgent: "therapist" },
        recordedAfterMessageCount: 0,
      },
    ]);
  });
  it("keeps app markers out of the LLM message history on a written file", async () => {
    const sessionsDir = await makeTempDir();
    const manager2 = new SessionManager(sessionsDir);
    const created = await manager2.create(sessionsDir, "anthropic", "test-model");
    await manager2.appendEntry(created.path, entry("m1"));
    await manager2.appendEntry(
      created.path,
      autopilotEntry(
        "u1",
        { version: 1, kind: "user_hint", afterMessageCount: 1, data: { kenSent: true } },
        APP_MARKER_CUSTOM_KIND,
      ),
    );
    const loaded = await manager2.load(created.path);
    const msgs = manager2.getMessages(loaded.entries, loaded.header.leafId);
    expect(JSON.stringify(msgs)).not.toContain("kenSent");
    expect(manager2.getAppMarkers(loaded.entries)).toEqual([
      {
        version: 1,
        kind: "user_hint",
        afterMessageCount: 1,
        data: { kenSent: true },
        // One message entry was written before the marker line.
        recordedAfterMessageCount: 1,
      },
    ]);
  });
});

describe("SessionManager turn metrics", () => {
  const metric: TurnMetricPayload = {
    version: 1,
    turn: 1,
    provider: "openai",
    model: "gpt-5.6-sol",
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 25, cacheRead: 50 },
    timing: {
      startedAt: 1_000,
      firstProviderEventAt: 1_020,
      completedAt: 1_100,
      providerDurationMs: 80,
      ttftMs: 20,
      outputTokensPerSecond: 312.5,
    },
    cost: { status: "unavailable", reason: "No authoritative pricing" },
  };

  it("persists and reads validated metrics without putting them on the message DAG", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create("/project", "openai", "gpt-5.6-sol");
    await manager.appendTurnMetric(created.path, metric);
    const loaded = await manager.load(created.path);

    expect(manager.getTurnMetrics(loaded.entries)).toEqual([metric]);
    expect(manager.getMessages(loaded.entries)).toEqual([]);
  });

  it("ignores malformed legacy metric entries", () => {
    const manager = new SessionManager("/unused");
    const entries: SessionEntry[] = [
      autopilotEntry("bad-version", { ...metric, version: 0 }, TURN_METRIC_CUSTOM_KIND),
      autopilotEntry(
        "bad-timing",
        { ...metric, timing: { ...metric.timing, completedAt: "later" } },
        TURN_METRIC_CUSTOM_KIND,
      ),
      autopilotEntry("valid", metric, TURN_METRIC_CUSTOM_KIND),
    ];

    expect(manager.getTurnMetrics(entries)).toEqual([metric]);
  });
});

describe("SessionManager.getMostRecent", () => {
  it("returns the session most recently spoken in, not the newest-created", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const cwd = "/proj/continue";

    // Session A is created first, then session B (newer header timestamp).
    const sessionA = await manager.create(cwd, "anthropic", "test-model");
    await new Promise((r) => setTimeout(r, 5));
    const sessionB = await manager.create(cwd, "anthropic", "test-model");

    // We chat in B first, then send the LAST message to A.
    await manager.appendEntry(sessionB.path, entry("b-msg"));
    await new Promise((r) => setTimeout(r, 5));
    await manager.appendEntry(sessionA.path, entry("a-msg"));

    const mostRecent = await manager.getMostRecent(cwd);
    expect(mostRecent).toBe(sessionA.path);
  });

  it("sorts conversations by activity after selecting each canonical checkpoint", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const cwd = "/proj/cross-conversation-recency";

    const olderConversation = await manager.create(cwd, "anthropic", "test-model");
    const olderCheckpoint = await manager.create(cwd, "anthropic", "test-model", {
      conversationId: olderConversation.id,
      generation: 5,
      parentSessionId: olderConversation.id,
    });
    await manager.appendEntry(olderCheckpoint.path, entry("older checkpoint message"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const recentConversation = await manager.create(cwd, "anthropic", "test-model");
    await manager.appendEntry(recentConversation.path, entry("recent conversation message"));

    expect(await manager.getMostRecent(cwd)).toBe(recentConversation.path);
  });
});

describe("SessionManager.pruneOldSessions", () => {
  async function makeAgedSession(
    manager: SessionManager,
    cwd: string,
    ageDays: number,
  ): Promise<string> {
    const created = await manager.create(cwd, "anthropic", "test-model");
    const past = new Date(Date.now() - ageDays * 86_400_000);
    await utimes(created.path, past, past);
    return created.path;
  }

  it("deletes sessions older than the retention window and keeps recent ones", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const oldPath = await makeAgedSession(manager, "/proj/a", 45);
    const recentPath = await makeAgedSession(manager, "/proj/a", 5);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30 });

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
  });

  it("never deletes paths listed in keepPaths, even when old", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const activePath = await makeAgedSession(manager, "/proj/b", 90);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30, keepPaths: [activePath] });

    expect(result.deletedFiles).toBe(0);
    expect(existsSync(activePath)).toBe(true);
  });

  it("removes project dirs left empty and is a no-op when retention is 0", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const oldPath = await makeAgedSession(manager, "/proj/c", 60);

    const disabled = await manager.pruneOldSessions({ maxAgeDays: 0 });
    expect(disabled.deletedFiles).toBe(0);
    expect(existsSync(oldPath)).toBe(true);

    await manager.pruneOldSessions({ maxAgeDays: 30 });
    expect(existsSync(oldPath)).toBe(false);
    expect(await readdir(sessionsDir)).toHaveLength(0);
  });
});

describe("approved plan consumption", () => {
  it("restores the exact committed content and latest valid state", async () => {
    const manager = new SessionManager(await makeTempDir());
    const content = "# Human-approved plan\n\n## Steps\n1. Implement it.";
    const contentHash = approvedPlanContentHash(content);
    const base = {
      version: 1 as const,
      checkpointId: "checkpoint-1",
      generation: 2,
      content,
      contentHash,
      approvedPlanPath: "/mutable/approved.md",
    };
    const entries: SessionEntry[] = [
      {
        type: "custom",
        kind: APPROVED_PLAN_CONSUMPTION_CUSTOM_KIND,
        id: "committed",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: { ...base, state: "approval-committed" },
      },
      {
        type: "custom",
        kind: APPROVED_PLAN_CONSUMPTION_CUSTOM_KIND,
        id: "started",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: { ...base, state: "implementation-prompt-started" },
      },
    ];

    expect(manager.getApprovedPlanConsumption(entries)).toEqual({
      ...base,
      state: "implementation-prompt-started",
    });
  });

  it("binds a legacy approved plan to the phase active when approval was recorded", async () => {
    const manager = new SessionManager(await makeTempDir());
    const phaseContext = (phaseId: string, sessionPath: string) => ({
      version: 1 as const,
      projectKey: "c:/project",
      phase: {
        id: phaseId,
        title: phaseId,
        goal: "goal",
        doneWhen: ["done"],
        sourcePrompt: null,
        status: "in-progress" as const,
        archivedAt: null,
      },
      session: { sessionId: phaseId, sessionPath },
      references: [],
      executionStage: "implementing" as const,
      approvedPlanPath: `${sessionPath}.md`,
    });
    const content = "# Plan\n\n## Steps\n1. Implement it.";
    const entries: SessionEntry[] = [
      {
        type: "custom",
        kind: ACTIVE_PHASE_CONTEXT_KIND,
        id: "phase-4",
        parentId: null,
        timestamp: "2026-08-30T10:00:00.000Z",
        data: phaseContext("phase-4", "phase-4.jsonl"),
      },
      {
        type: "custom",
        kind: APPROVED_PLAN_CONSUMPTION_CUSTOM_KIND,
        id: "approved",
        parentId: null,
        timestamp: "2026-08-30T10:01:00.000Z",
        data: {
          version: 1,
          checkpointId: "5ab5bc79-2d1b-4578-b6d3-7035a4723a91",
          generation: 1,
          content,
          contentHash: approvedPlanContentHash(content),
          state: "approval-committed",
        },
      },
      {
        type: "custom",
        kind: ACTIVE_PHASE_CONTEXT_KIND,
        id: "phase-5",
        parentId: null,
        timestamp: "2026-08-30T10:02:00.000Z",
        data: phaseContext("a639ff7d-64bf-4abe-a38e-cf6cae0acac2", "phase-5.jsonl"),
      },
    ];

    expect(manager.getApprovedPlanPhaseContext(entries)?.phase.id).toBe("phase-4");
  });
  it("ignores substituted content whose hash no longer matches", async () => {
    const manager = new SessionManager(await makeTempDir());
    const entries: SessionEntry[] = [
      {
        type: "custom",
        kind: APPROVED_PLAN_CONSUMPTION_CUSTOM_KIND,
        id: "tampered",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: {
          version: 1,
          checkpointId: "checkpoint-1",
          generation: 2,
          content: "substituted content",
          contentHash: approvedPlanContentHash("human-approved content"),
          state: "approval-committed",
        },
      },
    ];

    expect(manager.getApprovedPlanConsumption(entries)).toBeUndefined();
  });
});
