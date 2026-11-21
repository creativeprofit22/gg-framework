import { describe, expect, it } from "vitest";
import {
  clampGitBranchListLimit,
  GIT_BRANCH_LIST_DEFAULT_LIMIT,
  GIT_BRANCH_LIST_MAX_LIMIT,
  GIT_BRANCH_QUERY_MAX_LENGTH,
  GIT_BRANCH_SWITCH_MAX_FILES,
  GIT_BRANCH_SWITCH_MAX_PANES,
  GIT_BRANCH_SWITCH_REASON_MAX_LENGTH,
  isGitBranchListResponse,
  isGitBranchSwitchResponse,
  normalizeGitBranchQuery,
  type GitBranchListOk,
} from "./git-branch-contract.js";

const ok: GitBranchListOk = {
  status: "ok",
  current: { name: "main", detached: false, commit: "abc1234" },
  hasCommits: true,
  remote: "origin",
  defaultBranch: { name: "main", source: "remote-head" },
  local: [
    {
      name: "main",
      current: true,
      lastUsedAt: "2026-11-20T10:00:00.000Z",
      upstream: "origin/main",
    },
    { name: "feature/a/b", current: false, lastUsedAt: null, upstream: null },
  ],
  remoteOnly: [{ name: "release", remoteRef: "origin/release", lastCommitAt: null }],
  localTotal: 2,
  remoteOnlyTotal: 1,
  truncated: false,
};

describe("clampGitBranchListLimit", () => {
  it("defaults, floors and clamps", () => {
    expect(clampGitBranchListLimit(undefined)).toBe(GIT_BRANCH_LIST_DEFAULT_LIMIT);
    expect(clampGitBranchListLimit("abc")).toBe(GIT_BRANCH_LIST_DEFAULT_LIMIT);
    expect(clampGitBranchListLimit(Number.NaN)).toBe(GIT_BRANCH_LIST_DEFAULT_LIMIT);
    expect(clampGitBranchListLimit("")).toBe(GIT_BRANCH_LIST_DEFAULT_LIMIT);
    expect(clampGitBranchListLimit("12")).toBe(12);
    expect(clampGitBranchListLimit(7.9)).toBe(7);
    expect(clampGitBranchListLimit(0)).toBe(1);
    expect(clampGitBranchListLimit(-5)).toBe(1);
    expect(clampGitBranchListLimit(10_000)).toBe(GIT_BRANCH_LIST_MAX_LIMIT);
  });
});

describe("normalizeGitBranchQuery", () => {
  it("trims, caps and drops empty input", () => {
    expect(normalizeGitBranchQuery("  feat ")).toBe("feat");
    expect(normalizeGitBranchQuery("   ")).toBeUndefined();
    expect(normalizeGitBranchQuery(3)).toBeUndefined();
    expect(normalizeGitBranchQuery("x".repeat(500))).toHaveLength(GIT_BRANCH_QUERY_MAX_LENGTH);
  });
});

describe("isGitBranchListResponse", () => {
  it("accepts ok and not-a-repo responses", () => {
    expect(isGitBranchListResponse(ok)).toBe(true);
    expect(isGitBranchListResponse({ status: "not-a-repo" })).toBe(true);
    expect(
      isGitBranchListResponse({
        ...ok,
        current: { name: null, detached: true, commit: "abc1234" },
        remote: null,
        defaultBranch: null,
      }),
    ).toBe(true);
    expect(
      isGitBranchListResponse({
        ...ok,
        current: { name: "main", detached: false, commit: null },
        hasCommits: false,
        local: [],
        localTotal: 0,
      }),
    ).toBe(true);
  });

  it("rejects off-shape responses", () => {
    expect(isGitBranchListResponse(null)).toBe(false);
    expect(isGitBranchListResponse({ status: "error" })).toBe(false);
    expect(isGitBranchListResponse({ ...ok, local: "main" })).toBe(false);
    expect(isGitBranchListResponse({ ...ok, remote: "upstream" })).toBe(false);
    expect(isGitBranchListResponse({ ...ok, localTotal: 1 })).toBe(false);
    expect(isGitBranchListResponse({ ...ok, remoteOnlyTotal: -1 })).toBe(false);
    expect(isGitBranchListResponse({ ...ok, truncated: "no" })).toBe(false);
    expect(
      isGitBranchListResponse({ ...ok, current: { name: "main", detached: true, commit: null } }),
    ).toBe(false);
    expect(
      isGitBranchListResponse({ ...ok, defaultBranch: { name: "main", source: "guess" } }),
    ).toBe(false);
    expect(
      isGitBranchListResponse({
        ...ok,
        local: [{ name: "", current: false, lastUsedAt: null, upstream: null }],
      }),
    ).toBe(false);
    expect(
      isGitBranchListResponse({
        ...ok,
        local: [{ name: "a", current: false, lastUsedAt: "not a date", upstream: null }],
      }),
    ).toBe(false);
    expect(
      isGitBranchListResponse({ ...ok, remoteOnly: [{ name: "x", lastCommitAt: null }] }),
    ).toBe(false);
    const tooMany = Array.from({ length: GIT_BRANCH_LIST_MAX_LIMIT + 1 }, (_, index) => ({
      name: `b${index}`,
      current: false,
      lastUsedAt: null,
      upstream: null,
    }));
    expect(isGitBranchListResponse({ ...ok, local: tooMany, localTotal: tooMany.length })).toBe(
      false,
    );
  });
});

describe("isGitBranchSwitchResponse", () => {
  it("accepts every status", () => {
    for (const value of [
      {
        status: "switched",
        from: "main",
        to: "feature/x",
        trackedRemote: "origin/feature/x",
        carriedChanges: true,
      },
      { status: "switched", from: null, to: "main", trackedRemote: null, carriedChanges: false },
      { status: "unchanged", branch: "main" },
      { status: "conflict", reason: "Clash", files: ["a.txt", "dir/b.txt"], filesTruncated: false },
      { status: "conflict", reason: "Clash", files: [], filesTruncated: false },
      { status: "busy", reason: "Busy", panes: ["Fix login"] },
      { status: "not-found", reason: "No branch" },
      { status: "not-a-repo" },
    ]) {
      expect(isGitBranchSwitchResponse(value)).toBe(true);
    }
  });

  it("rejects malformed and oversized responses", () => {
    expect(isGitBranchSwitchResponse(null)).toBe(false);
    expect(isGitBranchSwitchResponse({ status: "ok" })).toBe(false);
    expect(
      isGitBranchSwitchResponse({
        status: "switched",
        from: "main",
        to: "",
        trackedRemote: null,
        carriedChanges: false,
      }),
    ).toBe(false);
    expect(
      isGitBranchSwitchResponse({ status: "switched", from: "main", to: "x", trackedRemote: null }),
    ).toBe(false);
    expect(isGitBranchSwitchResponse({ status: "unchanged" })).toBe(false);
    expect(
      isGitBranchSwitchResponse({
        status: "conflict",
        reason: "Clash",
        files: [""],
        filesTruncated: false,
      }),
    ).toBe(false);
    expect(
      isGitBranchSwitchResponse({
        status: "conflict",
        reason: "Clash",
        files: Array.from({ length: GIT_BRANCH_SWITCH_MAX_FILES + 1 }, (_, i) => `f${i}`),
        filesTruncated: true,
      }),
    ).toBe(false);
    expect(
      isGitBranchSwitchResponse({
        status: "busy",
        reason: "x".repeat(GIT_BRANCH_SWITCH_REASON_MAX_LENGTH + 1),
        panes: [],
      }),
    ).toBe(false);
    expect(
      isGitBranchSwitchResponse({
        status: "busy",
        reason: "Busy",
        panes: Array.from({ length: GIT_BRANCH_SWITCH_MAX_PANES + 1 }, () => "p"),
      }),
    ).toBe(false);
    expect(isGitBranchSwitchResponse({ status: "not-found", reason: "" })).toBe(false);
  });
});
