import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isProjectNotesStorageDiagnostics } from "@kenkaiiii/gg-core/project-notes-diagnostics";
import {
  buildProjectNotesStorageDiagnostics,
  createAppSidecarStorageDiagnostics,
  parseAppIdentityArgument,
  type BuildProjectNotesStorageDiagnosticsInput,
} from "./app-sidecar-storage-diagnostics.js";

const currentSession = {
  sessionId: "session-current",
  sessionPath: "C:\\agent\\sessions\\current.jsonl",
};
const activePhase = {
  phaseId: "phase-1",
  projectKey: "c:/work/project",
  session: currentSession,
};

function input(
  overrides: Partial<BuildProjectNotesStorageDiagnosticsInput> = {},
): BuildProjectNotesStorageDiagnosticsInput {
  return {
    applicationIdentity: "com.ggcoder.local-fork",
    agentDataRoot: "C:\\agent",
    canonicalCwd: "c:/work/project",
    projectKey: "c:/work/project",
    projectNotesStore: {
      primaryPath: "C:\\agent\\project-notes\\project.json",
      backupPath: "C:\\agent\\project-notes\\project.backup.json",
    },
    logicalSessionId: "logical-current",
    currentSession,
    activePhaseContext: activePhase,
    persistedPhaseBinding: activePhase,
    storeAvailable: true,
    ...overrides,
  };
}

describe("app sidecar storage diagnostics", () => {
  it("projects production and Local Fork identities into distinct canonical roots", () => {
    const production = buildProjectNotesStorageDiagnostics(
      input({
        applicationIdentity: "com.ggcoder.app",
        agentDataRoot: "C:\\Users\\tester\\.gg",
        projectNotesStore: {
          primaryPath: "C:\\Users\\tester\\.gg\\project-notes\\project.json",
          backupPath: "C:\\Users\\tester\\.gg\\project-notes\\project.backup.json",
        },
      }),
    );
    const localFork = buildProjectNotesStorageDiagnostics(input());

    expect(production.applicationIdentity).toBe("com.ggcoder.app");
    expect(localFork.applicationIdentity).toBe("com.ggcoder.local-fork");
    expect(production.agentDataRoot).not.toBe(localFork.agentDataRoot);
    expect(production.projectNotesStore.primaryPath).not.toBe(
      localFork.projectNotesStore.primaryPath,
    );
    expect(isProjectNotesStorageDiagnostics(production)).toBe(true);
    expect(isProjectNotesStorageDiagnostics(localFork)).toBe(true);
  });

  it.each([
    [input(), "consistent"],
    [input({ activePhaseContext: null, persistedPhaseBinding: null }), "unbound"],
    [
      input({
        persistedPhaseBinding: {
          ...activePhase,
          session: { sessionId: "session-other", sessionPath: "C:\\sessions\\other.jsonl" },
        },
      }),
      "bound-to-other-session",
    ],
    [input({ applicationIdentity: null }), "identity-mismatch"],
    [
      input({ activePhaseContext: { ...activePhase, projectKey: "c:/work/other" } }),
      "project-mismatch",
    ],
    [input({ storeAvailable: false }), "store-unavailable"],
  ] as const)("classifies the exact runtime relationship as %s", (fixture, expected) => {
    expect(buildProjectNotesStorageDiagnostics(fixture).consistency).toBe(expected);
  });

  it("parses exactly one bounded application identity argument", () => {
    expect(parseAppIdentityArgument(["node", "sidecar", "--gg-app-identity=com.ggcoder.app"])).toBe(
      "com.ggcoder.app",
    );
    expect(parseAppIdentityArgument(["node", "sidecar"])).toBeNull();
    expect(parseAppIdentityArgument(["--gg-app-identity=../../profile"])).toBeNull();
    expect(
      parseAppIdentityArgument([
        "--gg-app-identity=com.ggcoder.app",
        "--gg-app-identity=com.ggcoder.local-fork",
      ]),
    ).toBeNull();
  });

  it("uses only the injected repository and resolved runtime values", async () => {
    const repository = {
      paths: vi.fn((_cwd: string) => ({
        directory: path.join("C:\\agent", "project-notes"),
        primary: path.join("C:\\agent", "project-notes", "project.json"),
        backup: path.join("C:\\agent", "project-notes", "project.backup.json"),
        lock: path.join("C:\\agent", "project-notes", "project.json.lock"),
      })),
      load: vi.fn(async () => ({ status: "missing" as const })),
    };
    const diagnostics = createAppSidecarStorageDiagnostics({
      applicationIdentity: "com.ggcoder.local-fork",
      agentDataRoot: "C:\\agent",
      repository,
    });

    const result = await diagnostics.inspect({
      cwd: "C:\\work\\project",
      logicalSessionId: "logical-current",
      currentSession: { sessionId: "session-current", sessionPath: null },
      activePhaseContext: undefined,
    });

    expect(repository.paths).toHaveBeenCalledOnce();
    expect(repository.load).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      applicationIdentity: "com.ggcoder.local-fork",
      agentDataRoot: "C:\\agent",
      projectKey: "c:/work/project",
      consistency: "unbound",
    });
  });

  it("reports repository read failures without exposing their messages", async () => {
    const repository = {
      paths: () => ({
        directory: "C:\\agent\\project-notes",
        primary: "C:\\agent\\project-notes\\project.json",
        backup: "C:\\agent\\project-notes\\project.backup.json",
        lock: "C:\\agent\\project-notes\\project.json.lock",
      }),
      load: vi.fn(async () => {
        throw new Error("C:\\secret\\profile permission denied");
      }),
    };
    const diagnostics = createAppSidecarStorageDiagnostics({
      applicationIdentity: "com.ggcoder.local-fork",
      agentDataRoot: "C:\\agent",
      repository,
    });

    const result = await diagnostics.inspect({
      cwd: "C:\\work\\project",
      logicalSessionId: "logical-current",
      currentSession,
      activePhaseContext: undefined,
    });

    expect(result.consistency).toBe("store-unavailable");
    expect(JSON.stringify(result)).not.toContain("permission denied");
  });
});
