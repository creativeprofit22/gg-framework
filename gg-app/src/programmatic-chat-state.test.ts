import { describe, expect, it } from "vitest";
import {
  isProgrammaticAssessmentEvent,
  type ProgrammaticAssessment,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import {
  isProgrammaticChatResponse,
  type ProgrammaticChatConfiguration,
  type ProgrammaticChatResponse,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  canRunProgrammaticSelection,
  canScanProgrammatic,
  isProgrammaticCurrentReview,
  programmaticConfiguration,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
it.each([
  "saved",
  "disabled",
  "setup-not-saved",
  "unsaved",
  "acknowledgement-unknown",
  undefined,
] as const)("preserves %s history independently of successful scans and selection", (status) => {
  const assessmentId = "12345678-1234-4234-8234-123456789abc";
  const history: ProgrammaticAssessment["history"] =
    status === undefined
      ? undefined
      : status === "saved"
        ? { status, assessmentId, historyRevision: 1 }
        : status === "disabled" || status === "setup-not-saved"
          ? { status }
          : { status, assessmentId, reason: "History storage unavailable." };
  const assessment: ProgrammaticAssessment = {
    version: 1,
    mode: status === "setup-not-saved" ? "setup" : "configured",
    status: "completed",
    summary: "Assessment finished.",
    limitations: [],
    coverage: [],
    observations: [],
    deterministic:
      status === "setup-not-saved"
        ? { status: "not-run", reason: "setup" }
        : { status: "succeeded", enabledCount: 1, applicableCount: 1 },
    ...(history ? { history } : {}),
  };
  const original = loadedState();
  const event = {
    conversationId: "chat",
    sessionId: "session",
    sequence: 1,
    phase: "completed" as const,
    assessment,
  };
  expect(isProgrammaticAssessmentEvent(event)).toBe(true);
  const state = programmaticChatReducer(original, { type: "assessment", generation: "one", event });
  expect(state.assessment).toBe(assessment);
  expect(state.report).toBe(original.report);
  expect(state.detail).toBe(original.detail);
  expect(state.selectedId).toBe(original.selectedId);
  expect(state.error).toBeNull();
  expect(state.reconcile).toBe(false);
  if (status !== "setup-not-saved") {
    const receipt = receive(state, {
      version: 1,
      action: "scan",
      ok: true,
      changed: true,
      assessment,
    });
    expect(receipt.assessment).toBe(assessment);
    expect(receipt.report?.rows).toBe(original.report?.rows);
    expect(receipt.selectedId).toBe(original.selectedId);
    expect(receipt.detail).toBe(original.detail);
    expect(receipt.error).toBeNull();
  }
});
it("leaves deterministic state untouched by separate history responses", () => {
  const state = loadedState();
  for (const updated of [
    receive(state, { version: 1, action: "history-apply", ok: true, changed: true }),
    receive(state, {
      version: 1,
      action: "history-apply",
      ok: false,
      error: "Review expired",
      reconcile: true,
    }),
  ]) {
    expect(updated.report).toBe(state.report);
    expect(updated.detail).toBe(state.detail);
    expect(updated.selectedId).toBe(state.selectedId);
    expect(updated.operation).toBeNull();
  }
  expect(
    receive(state, {
      version: 1,
      action: "history-apply",
      ok: false,
      error: "Review expired",
      reconcile: true,
    }),
  ).toMatchObject({ error: "Review expired", reconcile: true });
});
it("retains an explicitly reviewed history upgrade through unchanged scanner reports", () => {
  const reviewed = receive(loadedState(), {
    version: 1,
    action: "inspect-setup",
    ok: true,
    proposal: {
      ...proposal,
      operation: "history-upgrade",
      configuration: currentConfiguration,
      profileJson: `${JSON.stringify({ scanners: [], version: 1 }, null, 2)}\n`,
      fingerprint: currentConfiguration.currentFingerprint!,
      historyPolicy: { version: 1, enabled: true },
      expectedRecoveryDigest: null,
    },
  });
  const state = receive(reviewed, {
    version: 1,
    action: "report",
    ok: true,
    report: { ...loadedState().report!, configuration: currentConfiguration },
  });
  expect(state.proposalApprovable).toBe(true);
  expect(state.selectedId).toBe(reviewed.selectedId);
  expect(
    receive(state, {
      version: 1,
      action: "report",
      ok: true,
      report: {
        ...loadedState().report!,
        configuration: { ...currentConfiguration, currentFingerprint: "f".repeat(64) },
      },
    }).proposalApprovable,
  ).toBe(false);
});
it("retains bounded assessment through reports, rejects stale outcomes and clears on reset", () => {
  const assessment = {
    version: 1 as const,
    mode: "setup" as const,
    status: "incomplete" as const,
    summary: "Only documentation inspected",
    limitations: ["Source budget exhausted"],
    coverage: [],
    observations: [],
    deterministic: { status: "not-run" as const, reason: "setup" as const },
  };
  const exactProposal = {
    ...proposal,
    profileJson: `${JSON.stringify({ scanners: [], version: 1 }, null, 2)}\n`,
  };
  let state = receive(initialProgrammaticChatState("one"), {
    version: 1,
    action: "inspect-setup",
    ok: true,
    proposal: exactProposal,
    assessment,
  });
  expect(state.assessment).toEqual(assessment);
  expect(state.proposal).toBe(exactProposal);
  expect(state.proposalApprovable).toBe(true);
  state = receive(state, { version: 1, action: "report", ok: true, report: loadedState().report! });
  expect(state.assessment).toEqual(assessment);
  const response = {
    version: 1 as const,
    action: "scan" as const,
    ok: true as const,
    changed: false,
  };
  expect(
    programmaticChatReducer(state, {
      type: "response",
      generation: "old",
      epoch: state.epoch,
      response,
    }),
  ).toBe(state);
  expect(
    programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: state.epoch - 1,
      response,
    }),
  ).toBe(state);
  expect(
    programmaticChatReducer(state, { type: "reset", generation: "two" }).assessment,
  ).toBeNull();
  expect(receive(state, response).assessment).toBe(assessment);
  const failed = receive(state, {
    version: 1,
    action: "inspect-setup",
    ok: false,
    error: "Cannot propose settings",
    reconcile: false,
    assessment: { ...assessment, status: "unavailable" },
  });
  expect(failed.assessment?.status).toBe("unavailable");
  expect(failed.proposalApprovable).toBe(false);
});

it("replaces assessment without changing in-flight setup ownership and rejects retired updates", () => {
  const assessment = {
    version: 1 as const,
    mode: "setup" as const,
    status: "unavailable" as const,
    summary: "Unavailable",
    limitations: [],
    coverage: [],
    observations: [],
    deterministic: { status: "not-run" as const, reason: "setup" as const },
  };
  let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
    type: "start",
    generation: "one",
    epoch: 1,
    operation: "inspect-setup",
  });
  const identity = { conversationId: "chat", sessionId: "session", sequence: 2 };
  state = programmaticChatReducer(state, {
    type: "assessment",
    generation: "one",
    event: { ...identity, phase: "started" },
  });
  expect(state.assessment).toBeNull();
  const completion = {
    type: "assessment" as const,
    generation: "one",
    event: { ...identity, phase: "completed" as const, assessment },
  };
  state = programmaticChatReducer(state, completion);
  expect(state).toMatchObject({ epoch: 1, operation: "inspect-setup", assessment });
  const exactProposal = {
    ...proposal,
    profileJson: `${JSON.stringify({ scanners: [], version: 1 }, null, 2)}\n`,
  };
  state = receive(state, {
    version: 1,
    action: "inspect-setup",
    ok: true,
    proposal: exactProposal,
    assessment,
  });
  expect(state.proposal).toBe(exactProposal);
  expect(state.proposalApprovable).toBe(true);
  expect(programmaticChatReducer(state, completion)).toBe(state);
  expect(programmaticChatReducer(state, { ...completion, generation: "retired" })).toBe(state);
  expect(
    programmaticChatReducer(state, { ...completion, event: { ...completion.event, sequence: 1 } }),
  ).toBe(state);
  state = programmaticChatReducer(state, {
    type: "assessment",
    generation: "one",
    event: { ...identity, sequence: 3, phase: "started" },
  });
  expect(state.assessment).toBe(assessment);
  expect(state.proposal).toBe(exactProposal);
});

const hash = "a".repeat(64);
const proposal = {
  handle: hash,
  operation: "initial" as const,
  configuration: {
    status: "missing" as const,
    currentFingerprint: hash,
    refreshAvailable: false,
    baselineUnavailable: false,
    diagnostic: null,
    drift: null,
  },
  fingerprint: hash,
  profileJson: "exact profile",
  routes: [],
  exclusions: [],
  configurationInputs: [],
};
const currentConfiguration: ProgrammaticChatConfiguration = {
  ...proposal.configuration,
  status: "current",
};
const driftConfiguration: ProgrammaticChatConfiguration = {
  ...currentConfiguration,
  status: "refresh-required",
  currentFingerprint: "b".repeat(64),
  refreshAvailable: true,
  drift: {
    files: [{ path: "package.json", kind: "modified", before: hash, after: "b".repeat(64) }],
    policy: null,
    schema: null,
    exclusions: null,
  },
};
function receive(
  state: ProgrammaticChatState,
  response: ProgrammaticChatResponse,
): ProgrammaticChatState {
  expect(isProgrammaticChatResponse(response)).toBe(true);
  return programmaticChatReducer(state, {
    type: "response",
    generation: state.generation,
    epoch: state.epoch,
    response,
  });
}
function loadedState(): ProgrammaticChatState {
  const summary = {
    id: hash,
    expectedOutput: "Review packaging",
    state: "discovered" as const,
    presence: "present" as const,
    mutationPaths: [],
    route: { available: true, command: "research" as const, reason: "Ready", machineLocal: false },
    actions: {
      run: { available: true, reason: "Ready" },
      dismiss: { available: true, reason: "Allowed" },
    },
  };
  let state = receive(initialProgrammaticChatState("one"), {
    version: 1,
    action: "report",
    ok: true,
    report: {
      status: "current",
      reason: "Current",
      scan: { available: true, reason: "Ready" },
      configuration: currentConfiguration,
      snapshot: hash,
      fingerprint: hash,
      offset: 0,
      total: 1,
      rows: [summary],
    },
  });
  state = programmaticChatReducer(state, { type: "select", id: hash });
  return receive(state, {
    version: 1,
    action: "detail",
    ok: true,
    snapshot: hash,
    detail: {
      summary,
      trigger: "Manifest",
      verification: "Check",
      risks: [],
      evidence: [],
      evidenceTruncated: false,
    },
  });
}
function inspect(
  state: ProgrammaticChatState,
  configuration: ProgrammaticChatConfiguration,
): ProgrammaticChatState {
  return receive(state, {
    version: 1,
    action: "inspect-setup",
    ok: true,
    proposal: {
      ...proposal,
      configuration,
      fingerprint: configuration.currentFingerprint!,
      profileJson: `${JSON.stringify({ scanners: [], version: 1 }, null, 2)}\n`,
      operation: configuration.status === "current" ? "current" : "refresh",
      handle: configuration.status === "current" ? null : hash,
    },
  });
}

describe("programmatic state", () => {
  it("uses inspection drift immediately without changing lifecycle snapshot or dismissal permissions", () => {
    const old = loadedState();
    expect(canScanProgrammatic(old)).toBe(true);
    expect(canRunProgrammaticSelection(old)).toBe(true);
    const state = inspect(old, driftConfiguration);
    expect(programmaticConfiguration(state)).toEqual(driftConfiguration);
    expect(canScanProgrammatic(state)).toBe(false);
    expect(canRunProgrammaticSelection(state)).toBe(false);
    expect(state.report).toBe(old.report);
    expect(state.detail).toBe(old.detail);
    expect(state.selectedId).toBe(hash);
    expect(state.detailSnapshot).toBe(hash);
    expect(state.detail?.summary.actions.dismiss.available).toBe(true);
  });
  it.each(["refresh-required", "unreadable", "missing"] as const)(
    "supersedes current reviews after a %s report",
    (status) => {
      const reviewed = inspect(loadedState(), currentConfiguration);
      expect(isProgrammaticCurrentReview(reviewed)).toBe(true);
      const configuration = {
        ...driftConfiguration,
        status,
        refreshAvailable: status === "refresh-required",
        currentFingerprint: status === "unreadable" ? null : driftConfiguration.currentFingerprint,
      };
      const state = receive(reviewed, {
        version: 1,
        action: "report",
        ok: true,
        report: {
          ...reviewed.report!,
          status: "stale",
          scan: { available: false, reason: "Setup changed" },
          configuration,
        },
      });
      expect(state.report?.snapshot).toBe(hash); // Config-only edits do not change lifecycle bytes.
      expect(state.proposal).toBe(reviewed.proposal);
      expect(isProgrammaticCurrentReview(state)).toBe(false);
      expect(programmaticConfiguration(state)).toEqual(configuration);
      expect(canScanProgrammatic(state)).toBe(false);
      expect(canRunProgrammaticSelection(state)).toBe(false);
    },
  );
  it("accepts a current inspection after a stale report without inventing fresh scan permissions", () => {
    const old = loadedState();
    const stale = receive(old, {
      version: 1,
      action: "report",
      ok: true,
      report: {
        ...old.report!,
        status: "stale",
        configuration: driftConfiguration,
        scan: { available: false, reason: "Setup changed" },
      },
    });
    const reverted = inspect(stale, currentConfiguration);
    expect(programmaticConfiguration(reverted)).toEqual(currentConfiguration);
    expect(isProgrammaticCurrentReview(reverted)).toBe(true);
    expect(canScanProgrammatic(reverted)).toBe(false);
    expect(canRunProgrammaticSelection(reverted)).toBe(false);
    const fresh = receive(reverted, {
      version: 1,
      action: "report",
      ok: true,
      report: old.report!,
    });
    expect(canScanProgrammatic(fresh)).toBe(true);
    expect(canRunProgrammaticSelection(fresh)).toBe(true);
  });
  it("retains matching refresh approval independently of lifecycle snapshot changes", () => {
    const reviewed = inspect(loadedState(), driftConfiguration);
    const matching = receive(reviewed, {
      version: 1,
      action: "report",
      ok: true,
      report: {
        ...reviewed.report!,
        snapshot: "c".repeat(64),
        status: "stale",
        configuration: driftConfiguration,
        scan: { available: false, reason: "Approve refresh" },
      },
    });
    expect(matching.proposalApprovable).toBe(true);
    expect(matching.proposal?.handle).toBe(reviewed.proposal?.handle);
    const missing = receive(matching, {
      version: 1,
      action: "report",
      ok: true,
      report: {
        ...matching.report!,
        configuration: { ...driftConfiguration, status: "missing", refreshAvailable: false },
      },
    });
    expect(missing.proposalApprovable).toBe(false);
  });
  it("ignores late configuration assessments and preserves all execution locks", () => {
    const drifted = inspect(loadedState(), driftConfiguration);
    const state = programmaticChatReducer(drifted, {
      type: "start",
      generation: "one",
      epoch: 2,
      operation: "report",
    });
    for (const identity of [
      { generation: "one", epoch: 1 },
      { generation: "old", epoch: 2 },
    ]) {
      expect(
        programmaticChatReducer(state, {
          type: "response",
          ...identity,
          response: { version: 1, action: "report", ok: true, report: loadedState().report! },
        }),
      ).toBe(state);
      expect(
        programmaticChatReducer(state, {
          type: "response",
          ...identity,
          response: {
            version: 1,
            action: "inspect-setup",
            ok: true,
            proposal: inspect(loadedState(), currentConfiguration).proposal!,
          },
        }),
      ).toBe(state);
    }
    for (const locked of [
      { ...loadedState(), reconcile: true },
      { ...loadedState(), operation: "report" as const },
    ]) {
      expect(canScanProgrammatic(locked)).toBe(false);
      expect(canRunProgrammaticSelection(locked)).toBe(false);
    }
  });
  it("invalidates approval when inspection says current or a report changes configuration", () => {
    const reviewed = programmaticChatReducer(initialProgrammaticChatState("one"), {
      type: "response",
      generation: "one",
      epoch: 0,
      response: { version: 1, action: "inspect-setup", ok: true, proposal },
    });
    const current = programmaticChatReducer(reviewed, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "inspect-setup",
        ok: true,
        proposal: {
          ...proposal,
          operation: "current",
          handle: null,
          configuration: { ...proposal.configuration, status: "current" },
        },
      },
    });
    expect(current.proposalApprovable).toBe(false);
    expect(current.notice).toBe("Saved settings are up to date. Nothing needs to be saved.");
    const changed = programmaticChatReducer(reviewed, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "report",
        ok: true,
        report: {
          status: "stale",
          reason: "Changed",
          scan: { available: false, reason: "Review setup" },
          snapshot: hash,
          fingerprint: hash,
          offset: 0,
          total: 0,
          rows: [],
          configuration: {
            ...proposal.configuration,
            currentFingerprint: "b".repeat(64),
            status: "refresh-required",
            refreshAvailable: true,
          },
        },
      },
    });
    expect(changed.proposalApprovable).toBe(false);
    expect(changed.proposal).toBe(proposal);
  });
  it.each(["rejected", "uncertain", "inspection-failed"])(
    "requires fresh inspection after %s without losing proposal context",
    (failure) => {
      let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
        type: "response",
        generation: "one",
        epoch: 0,
        response: { version: 1, action: "inspect-setup", ok: true, proposal },
      });
      expect(state.proposalApprovable).toBe(true);
      state = programmaticChatReducer(state, {
        type: "start",
        generation: "one",
        epoch: 1,
        operation: failure === "inspection-failed" ? "inspect-setup" : "approve-setup",
      });
      state = programmaticChatReducer(
        state,
        failure === "uncertain"
          ? { type: "error", generation: "one", epoch: 1, error: "unknown", reconcile: true }
          : {
              type: "response",
              generation: "one",
              epoch: 1,
              response: {
                version: 1,
                action: failure === "inspection-failed" ? "inspect-setup" : "approve-setup",
                ok: false,
                error: "rejected",
                reconcile: false,
              },
            },
      );
      expect(state.proposalApprovable).toBe(false);
      expect(state.proposal).toBe(proposal);
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 1,
        response: {
          version: 1,
          action: "report",
          ok: true,
          report: {
            status: "setup-required",
            reason: "Inspect setup",
            scan: { available: false, reason: "Approve setup" },
            snapshot: null,
            fingerprint: null,
            offset: 0,
            total: 0,
            rows: [],
          },
        },
      });
      expect(state.reconcile).toBe(false);
      expect(state.proposalApprovable).toBe(false);
      const fresh = { ...proposal, handle: "b".repeat(64) };
      state = programmaticChatReducer(state, {
        type: "start",
        generation: "one",
        epoch: 2,
        operation: "inspect-setup",
      });
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 2,
        response: { version: 1, action: "inspect-setup", ok: true, proposal: fresh },
      });
      expect(state.proposal).toBe(fresh);
      expect(state.proposalApprovable).toBe(true);
    },
  );
  it.each([undefined, hash, "b".repeat(64)])(
    "preserves only an explicitly retained matching handle: %s",
    (handle) => {
      const state = { ...initialProgrammaticChatState("one"), proposal, proposalApprovable: true };
      const event = {
        type: "response" as const,
        generation: "one",
        epoch: 0,
        response: {
          version: 1 as const,
          action: "approve-setup" as const,
          ok: false as const,
          error: "Not submitted",
          reconcile: false,
          ...(handle ? { approvableProposalHandle: handle } : {}),
        },
      };
      expect(programmaticChatReducer(state, event).proposalApprovable).toBe(handle === hash);
      expect(
        programmaticChatReducer({ ...state, proposalApprovable: false }, event).proposalApprovable,
      ).toBe(false);
    },
  );
  it("rejects old generations and epochs, and preserves selected context during scans", () => {
    let state = initialProgrammaticChatState("one");
    state = programmaticChatReducer(state, { type: "select", id: hash });
    state = programmaticChatReducer(state, {
      type: "start",
      generation: "one",
      epoch: 2,
      operation: "scan",
    });
    expect(state.selectedId).toBe(hash);
    expect(
      programmaticChatReducer(state, {
        type: "error",
        generation: "one",
        epoch: 1,
        error: "late",
        reconcile: true,
      }),
    ).toBe(state);
    expect(
      programmaticChatReducer(state, {
        type: "error",
        generation: "old",
        epoch: 2,
        error: "late",
        reconcile: true,
      }),
    ).toBe(state);
    const reset = programmaticChatReducer(state, { type: "reset", generation: "two" });
    expect(reset.selectedId).toBeNull();
    expect(
      programmaticChatReducer(reset, { type: "run-accepted", generation: "one", epoch: 2 }),
    ).toBe(reset);
  });
  it("keeps uncertain writes gated until an authoritative report arrives", () => {
    let state = initialProgrammaticChatState("one");
    state = programmaticChatReducer(state, {
      type: "error",
      generation: "one",
      epoch: 0,
      error: "unknown",
      reconcile: true,
    });
    expect(state.reconcile).toBe(true);
    expect(canRunProgrammaticSelection(state)).toBe(false);
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "report",
        ok: true,
        report: {
          status: "setup-required",
          reason: "Inspect setup",
          scan: { available: false, reason: "Approve current setup." },
          snapshot: null,
          fingerprint: null,
          offset: 0,
          total: 0,
          rows: [],
        },
      },
    });
    expect(state.reconcile).toBe(false);
  });
  it("explains a missing recovered selection without choosing another", () => {
    let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
      type: "select",
      id: hash,
    });
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: { version: 1, action: "detail", ok: true, snapshot: hash, detail: null },
    });
    expect(state.missingSelection).toBe(true);
    expect(state.selectedId).toBe(hash);
  });
});
