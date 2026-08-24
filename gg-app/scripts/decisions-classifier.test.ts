import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DECISION_SUMMARY_CONTEXT_MAX_BYTES,
  DECISION_SUMMARY_DIFF_MAX_BYTES,
  classifyBlobOutcome,
  fallbackDecisionSummary,
  generateDecisionSummaryContext,
  groupDecisionAreas,
  isDecisionNoise,
} from "./decisions-classifier.mjs";

let fixtureRoot = "";
let fixtureEvidence: { merge: string; base: string; localParent: string; upstreamParent: string };
const dangerousPath = "--context;echo-not-a-command.ts";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: fixtureRoot, encoding: "utf8" }).trim();
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "decision-summary-context-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(fixtureRoot, dangerousPath), "export const value = 'base';\n");
  writeFileSync(join(fixtureRoot, "feature.test.ts"), "test('base');\n");
  git("add", "--", dangerousPath, "feature.test.ts");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "local");
  writeFileSync(
    join(fixtureRoot, dangerousPath),
    `export const value = 'local';\n${"l".repeat(20_000)}\n`,
  );
  writeFileSync(join(fixtureRoot, "feature.test.ts"), "test('local');\n");
  git("commit", "-qam", "local");
  const localParent = git("rev-parse", "HEAD");
  git("checkout", "-qb", "upstream", base);
  writeFileSync(join(fixtureRoot, dangerousPath), "export const value = 'upstream';\n");
  writeFileSync(join(fixtureRoot, "feature.test.ts"), "test('upstream');\n");
  git("commit", "-qam", "upstream");
  const upstreamParent = git("rev-parse", "HEAD");
  git("checkout", "-q", "local");
  writeFileSync(join(fixtureRoot, dangerousPath), "export const value = 'merged';\n");
  writeFileSync(join(fixtureRoot, "feature.test.ts"), "test('merged');\n");
  git("add", "--", dangerousPath, "feature.test.ts");
  const tree = git("write-tree");
  const merge = git("commit-tree", tree, "-p", localParent, "-p", upstreamParent, "-m", "merged");
  fixtureEvidence = { merge, base, localParent, upstreamParent };
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("classifyBlobOutcome", () => {
  it.each([
    ["kept-local", { base: "base", local: "local", upstream: "upstream", merged: "local" }],
    [
      "adopted-upstream",
      { base: "base", local: "local", upstream: "upstream", merged: "upstream" },
    ],
    ["combined", { base: "base", local: "local", upstream: "upstream", merged: "merged" }],
  ] as const)("classifies %s from exact blob identity", (outcome, blobs) => {
    expect(classifyBlobOutcome(blobs)).toBe(outcome);
  });

  it.each([
    [
      "both sides produced the same blob",
      { base: "base", local: "same", upstream: "same", merged: "same" },
    ],
    [
      "the local side did not change",
      { base: "base", local: "base", upstream: "upstream", merged: "upstream" },
    ],
    [
      "the upstream side did not change",
      { base: "base", local: "local", upstream: "base", merged: "local" },
    ],
    [
      "the merged blob is unavailable",
      { base: "base", local: "local", upstream: "upstream", merged: undefined },
    ],
  ] as const)("leaves ambiguous evidence unresolved when %s", (_reason, blobs) => {
    expect(classifyBlobOutcome(blobs)).toBe("unresolved");
  });
});

describe("fallbackDecisionSummary", () => {
  it("explains each classification with friendly evidence-grounded language", () => {
    expect(
      fallbackDecisionSummary([
        { outcome: "kept-local" },
        { outcome: "adopted-upstream" },
        { outcome: "combined" },
        { outcome: "unresolved" },
      ]),
    ).toBe(
      "Your protected update is ready. It held onto your local work in one area because the finished update uses your version there. It brought in upstream's work in one area because the finished update uses that version there. It blended your work with upstream in one area, keeping changes from both sides. It left one area marked for review because the result did not point cleanly to either side.",
    );
  });
});

describe("decision summary context", () => {
  function record() {
    return {
      verification: { workflowVerified: true, recordedAt: "2026-08-24T10:00:15.000Z" },
      evidence: fixtureEvidence,
      decisions: [
        {
          area: "dangerous-name",
          outcome: "combined",
          files: [{ path: dangerousPath, role: "implementation" }],
        },
        {
          area: "feature",
          outcome: "combined",
          files: [{ path: "feature.test.ts", role: "test" }],
        },
      ],
    };
  }

  it("includes every Decision with argv-safe, bounded, explicitly truncated diffs", () => {
    const context = generateDecisionSummaryContext(fixtureRoot, record());
    expect(context.decisions.map(({ area }) => area)).toEqual(["dangerous-name", "feature"]);
    expect(context.decisions[0]?.files[0]?.path).toBe(dangerousPath);
    expect(context.decisions[0]?.files[0]?.diffs.baseToLocal.truncated).toBe(true);
    expect(
      Buffer.byteLength(context.decisions[0]!.files[0]!.diffs.baseToLocal.text),
    ).toBeLessThanOrEqual(DECISION_SUMMARY_DIFF_MAX_BYTES);
    expect(Buffer.byteLength(`${JSON.stringify(context, null, 2)}\n`)).toBeLessThanOrEqual(
      DECISION_SUMMARY_CONTEXT_MAX_BYTES,
    );
  });

  it("uses implementation files before tests at the file cap", () => {
    const value = record();
    value.decisions = [
      {
        area: "many",
        outcome: "combined",
        files: [
          ...Array.from({ length: 40 }, (_, index) => ({
            path: dangerousPath,
            role: "implementation" as const,
            index,
          })),
          { path: "feature.test.ts", role: "test" as const },
        ],
      },
    ];
    const context = generateDecisionSummaryContext(fixtureRoot, value);
    expect(context.decisions[0]?.files).toHaveLength(40);
    expect(context.decisions[0]?.files.every(({ role }) => role === "implementation")).toBe(true);
    expect(context.truncated).toBe(true);
  });
});

describe("decision areas", () => {
  it.each([
    "gg-app/package.json",
    "gg-app/src-tauri/Cargo.lock",
    "gg-app/src-tauri/Cargo.toml",
    "gg-app/src-tauri/tauri.conf.json",
    "gg-app/src/changelog.ts",
  ])("excludes metadata noise: %s", (path) => {
    expect(isDecisionNoise(path)).toBe(true);
  });

  it("groups an implementation with its test into one decision", () => {
    const decisions = groupDecisionAreas([
      { path: "src/system-prompt.test.ts", outcome: "combined", blobs: {} },
      { path: "src/system-prompt.ts", outcome: "combined", blobs: {} },
      { path: "package.json", outcome: "combined", blobs: {} },
    ]);

    expect(decisions).toEqual([
      {
        area: "src/system-prompt",
        outcome: "combined",
        files: [
          { path: "src/system-prompt.ts", outcome: "combined", blobs: {}, role: "implementation" },
          { path: "src/system-prompt.test.ts", outcome: "combined", blobs: {}, role: "test" },
        ],
      },
    ]);
  });

  it("marks mixed file outcomes unresolved instead of inventing an area outcome", () => {
    const [decision] = groupDecisionAreas([
      { path: "src/feature.ts", outcome: "kept-local", blobs: {} },
      { path: "src/feature.test.ts", outcome: "adopted-upstream", blobs: {} },
    ]);

    expect(decision.outcome).toBe("unresolved");
  });
});
