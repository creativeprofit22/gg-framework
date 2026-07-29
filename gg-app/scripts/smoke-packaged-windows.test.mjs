import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGED_WINDOWS_SMOKE_DISABLED_MESSAGE,
  discoverChangedMsi,
  discoverPackagedLayout,
  runPackagedWindowsSmoke,
  snapshotMsiArtifacts,
  waitFor,
} from "./smoke-packaged-windows.mjs";
import { PHASE20_PROMPT, validatePhase20Evidence } from "./phase-20-native-smoke.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "gg-app-packaged-smoke-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged Windows smoke artifact discovery", () => {
  it("selects only the MSI created or replaced by the current build", () => {
    const root = temporaryDirectory();
    const stale = join(root, "stale.msi");
    writeFileSync(stale, "old");
    const before = snapshotMsiArtifacts(root);
    const current = join(root, "current.msi");
    writeFileSync(current, "new");

    expect(discoverChangedMsi(before, snapshotMsiArtifacts(root))).toBe(current);
  });

  it("rejects ambiguous build output", () => {
    const root = temporaryDirectory();
    const before = snapshotMsiArtifacts(root);
    writeFileSync(join(root, "one.msi"), "one");
    writeFileSync(join(root, "two.msi"), "two");

    expect(() => discoverChangedMsi(before, snapshotMsiArtifacts(root))).toThrow(
      "expected one newly built MSI, found 2",
    );
  });

  it("requires the app, Node runtime, and sidecar in one extracted layout", () => {
    const root = temporaryDirectory();
    const install = join(root, "PFiles64", "GG Coder");
    mkdirSync(join(install, "sidecar"), { recursive: true });
    writeFileSync(join(install, "gg-app.exe"), "app");
    writeFileSync(join(install, "ggnode.exe"), "node");
    writeFileSync(join(install, "sidecar", "app-sidecar.mjs"), "sidecar");

    expect(discoverPackagedLayout(root).installDir).toBe(realpathSync.native(install));
  });
});

describe("packaged Windows smoke timeout", () => {
  it("stops polling at the configured deadline with the last probe error", async () => {
    let clock = 0;
    await expect(
      waitFor(
        "runtime evidence",
        () => {
          throw new Error("not ready");
        },
        {
          timeoutMs: 20,
          intervalMs: 5,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("runtime evidence timed out after 20ms: not ready");
  });
});

describe("Phase 20 native smoke evidence", () => {
  function baseEvidence() {
    return {
      initial: {
        oldPromptCount: 1,
        sentRowCount: 0,
        transcriptText: `Ken ${PHASE20_PROMPT}`,
      },
      final: {
        oldPromptCount: 0,
        sentRowCount: 1,
        transcriptText: "Sent to GG Coder",
        composerValue: "",
        alertText: "",
      },
      invokes: [
        { sequence: 1, type: "invoke:start", command: "agent_new_session" },
        {
          sequence: 3,
          type: "invoke:resolved",
          command: "agent_new_session",
          result: { operationId: "operation-1" },
        },
        { sequence: 4, type: "invoke:start", command: "agent_prompt" },
        { sequence: 5, type: "invoke:resolved", command: "agent_prompt", result: null },
      ],
      events: [
        {
          sequence: 2,
          type: "event:session_reset",
          paneId: "primary",
          operationId: "operation-1",
        },
      ],
      mutations: [
        { sequence: 6, type: "dom:old-transcript-removed" },
        { sequence: 7, type: "dom:ken-sent-added" },
      ],
      sequence: [],
      backend: {
        newSessions: [{ route: "/new-session", status: 200, operationId: "operation-1" }],
        prompts: [{ route: "/prompt", status: 202, kenSent: true }],
      },
    };
  }

  it("accepts one matching authoritative reset before one send and sent row", () => {
    const evidence = baseEvidence();
    evidence.sequence = [...evidence.invokes, ...evidence.events, ...evidence.mutations].sort(
      (left, right) => left.sequence - right.sequence,
    );

    expect(validatePhase20Evidence(evidence, "success")).toBe(evidence);
  });

  it("rejects a sent row that appears before old transcript removal", () => {
    const evidence = baseEvidence();
    evidence.mutations[0].sequence = 8;
    evidence.sequence = [...evidence.invokes, ...evidence.events, ...evidence.mutations].sort(
      (left, right) => left.sequence - right.sequence,
    );

    expect(() => validatePhase20Evidence(evidence, "success")).toThrow(
      "sent row appeared before old transcript removal",
    );
  });

  it("accepts typed native 409 rejection without a prompt send", () => {
    const evidence = baseEvidence();
    evidence.invokes = [
      { sequence: 1, type: "invoke:start", command: "agent_new_session" },
      {
        sequence: 2,
        type: "invoke:rejected",
        command: "agent_new_session",
        error: 'command failed: {"kind":"creation-rejected","status":409,"message":"conflict"}',
      },
    ];
    evidence.events = [];
    evidence.mutations = [];
    evidence.sequence = evidence.invokes;
    evidence.backend = {
      newSessions: [{ route: "/new-session", status: 409 }],
      prompts: [],
    };
    evidence.final = {
      oldPromptCount: 1,
      sentRowCount: 0,
      transcriptText: `Ken ${PHASE20_PROMPT}`,
      composerValue: "",
      alertText: "The current session is unchanged; try again.",
    };

    expect(validatePhase20Evidence(evidence, "reject-409")).toBe(evidence);
  });

  it("accepts lost-reset recovery only when the exact prompt is restored without sending", () => {
    const evidence = baseEvidence();
    evidence.invokes = [
      { sequence: 1, type: "invoke:start", command: "agent_new_session" },
      {
        sequence: 2,
        type: "invoke:resolved",
        command: "agent_new_session",
        result: { operationId: "operation-lost" },
      },
    ];
    evidence.events = [];
    evidence.mutations = [{ sequence: 3, type: "dom:old-transcript-removed" }];
    evidence.sequence = [...evidence.invokes, ...evidence.mutations];
    evidence.backend = {
      newSessions: [{ route: "/new-session", status: 200, operationId: "operation-lost" }],
      prompts: [],
    };
    evidence.final = {
      oldPromptCount: 0,
      sentRowCount: 0,
      transcriptText: "Ready for work",
      composerValue: PHASE20_PROMPT,
      alertText: "",
    };

    expect(validatePhase20Evidence(evidence, "drop-reset")).toBe(evidence);
  });
});

describe("packaged Windows smoke automation safety", () => {
  it("retires the runner and removes its normal package command", async () => {
    await expect(runPackagedWindowsSmoke()).rejects.toThrow(
      PACKAGED_WINDOWS_SMOKE_DISABLED_MESSAGE,
    );
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageManifest.scripts["smoke:packaged-windows"]).toBeUndefined();
  });

  it("contains no process, installer, launch, or cleanup integration", () => {
    const source = readFileSync(new URL("./smoke-packaged-windows.mjs", import.meta.url), "utf8");
    for (const forbidden of [
      "node:child_process",
      "taskkill.exe",
      "msiexec.exe",
      "Get-CimInstance",
      "Stop-Process",
      "WScript.Shell",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
