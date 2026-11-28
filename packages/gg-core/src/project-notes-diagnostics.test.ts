import { describe, expect, it } from "vitest";
import {
  PROJECT_NOTES_DIAGNOSTIC_CONSISTENCIES,
  isProjectNotesStorageDiagnostics,
  type ProjectNotesStorageDiagnostics,
} from "./project-notes-diagnostics.js";

const diagnostics = {
  version: 1,
  applicationIdentity: "com.ggcoder.local-fork",
  daemonOwner: "node-sidecar",
  agentDataRoot: "C:\\Users\\tester\\AppData\\Local\\gg-coder-local-fork\\agent",
  canonicalCwd: "C:\\work\\project",
  projectKey: "project-key",
  projectNotesStore: {
    primaryPath: "C:\\agent\\project-notes\\project-key.json",
    backupPath: "C:\\agent\\project-notes\\project-key.backup.json",
  },
  logicalSessionId: "logical-current",
  currentSession: {
    sessionId: "session-current",
    sessionPath: "C:\\agent\\sessions\\current.jsonl",
  },
  activePhaseContext: {
    phaseId: "phase-1",
    projectKey: "project-key",
    session: {
      sessionId: "session-current",
      sessionPath: "C:\\agent\\sessions\\current.jsonl",
    },
  },
  persistedPhaseBinding: {
    phaseId: "phase-1",
    projectKey: "project-key",
    session: {
      sessionId: "session-current",
      sessionPath: "C:\\agent\\sessions\\current.jsonl",
    },
  },
  consistency: "consistent",
} satisfies ProjectNotesStorageDiagnostics;

describe("Project Notes storage diagnostics contract", () => {
  it.each(PROJECT_NOTES_DIAGNOSTIC_CONSISTENCIES)("accepts %s diagnostics", (consistency) => {
    expect(isProjectNotesStorageDiagnostics({ ...diagnostics, consistency })).toBe(true);
  });

  it("accepts POSIX paths, null phase links, and an unpersisted session path", () => {
    expect(
      isProjectNotesStorageDiagnostics({
        ...diagnostics,
        agentDataRoot: "/home/tester/.gg",
        canonicalCwd: "/work/project",
        projectNotesStore: {
          primaryPath: "/home/tester/.gg/project-notes/project-key.json",
          backupPath: "/home/tester/.gg/project-notes/project-key.backup.json",
        },
        currentSession: { sessionId: "session-current", sessionPath: null },
        activePhaseContext: null,
        persistedPhaseBinding: null,
        consistency: "unbound",
      }),
    ).toBe(true);
  });

  it.each([
    "",
    " com.ggcoder.local-fork",
    "com/ggcoder/local-fork",
    "com.ggcoder.local fork",
    "x".repeat(257),
  ])("rejects invalid application identity %o", (applicationIdentity) => {
    expect(isProjectNotesStorageDiagnostics({ ...diagnostics, applicationIdentity })).toBe(false);
  });

  it("accepts a missing identity only as a typed mismatch", () => {
    expect(
      isProjectNotesStorageDiagnostics({
        ...diagnostics,
        applicationIdentity: null,
        consistency: "identity-mismatch",
      }),
    ).toBe(true);
    expect(isProjectNotesStorageDiagnostics({ ...diagnostics, applicationIdentity: null })).toBe(
      false,
    );
  });

  it.each([
    ["agentDataRoot", "relative/agent"],
    ["canonicalCwd", ""],
  ] as const)("rejects invalid %s paths", (key, path) => {
    expect(isProjectNotesStorageDiagnostics({ ...diagnostics, [key]: path })).toBe(false);
  });

  it("rejects relative store and session paths", () => {
    expect(
      isProjectNotesStorageDiagnostics({
        ...diagnostics,
        projectNotesStore: { ...diagnostics.projectNotesStore, primaryPath: "notes.json" },
      }),
    ).toBe(false);
    expect(
      isProjectNotesStorageDiagnostics({
        ...diagnostics,
        currentSession: { ...diagnostics.currentSession, sessionPath: "session.jsonl" },
      }),
    ).toBe(false);
  });

  it.each([
    { ...diagnostics, token: "secret" },
    { ...diagnostics, projectNotesStore: { ...diagnostics.projectNotesStore, extra: true } },
    {
      ...diagnostics,
      activePhaseContext: { ...diagnostics.activePhaseContext, identity: "unexpected" },
    },
  ])("rejects unknown keys", (value) => {
    expect(isProjectNotesStorageDiagnostics(value)).toBe(false);
  });

  it.each([
    undefined,
    { ...diagnostics, applicationIdentity: undefined },
    { ...diagnostics, daemonOwner: "webview" },
    { ...diagnostics, consistency: "unknown" },
    { ...diagnostics, currentSession: { sessionId: " ", sessionPath: null } },
  ])("fails closed for malformed diagnostics: %o", (value) => {
    expect(isProjectNotesStorageDiagnostics(value)).toBe(false);
  });
});
