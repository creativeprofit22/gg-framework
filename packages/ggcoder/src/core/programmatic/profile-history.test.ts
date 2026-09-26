import { mkdtemp, writeFile, readFile, mkdir, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile, loadApprovedProgrammaticProfile,
  PROGRAMMATIC_PREVIOUS_PROFILE_PATH, type PersistProgrammaticProfileOptions } from "./profile.js";
import { requireRecommendationHistoryPolicy } from "./recommendation-history.js";
import { ProgrammaticSetupReview } from "./setup-review.js";
import { sha256 } from "../tauri-package/paths.js";
const roots: string[] = [];
const profilePath = ".gg/programmatic/profile.json";
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-profile-history-")); roots.push(root);
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n'); return root;
}
async function legacy(root: string, version: 1 | 2 = 2) {
  const proposal = await buildProgrammaticProfileProposal(root);
  expect((await persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  if (version === 1) {
    const stored = (await loadApprovedProgrammaticProfile(root))!;
    await writeFile(path.join(root, profilePath), JSON.stringify({ version: 1, profile: stored.envelope.profile,
      configurationFingerprint: stored.envelope.configurationFingerprint }, null, 4) + "\n\n");
  }
  return readFile(path.join(root, profilePath));
}
async function upgrade(root: string, options: PersistProgrammaticProfileOptions = {}) {
  const proposal = await buildProgrammaticProfileProposal(root, { offerHistory: true });
  return persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
    expectedPriorProfileDigest: proposal.expectedPriorProfileDigest, historyPolicy: proposal.historyPolicy,
    expectedRecoveryDigest: proposal.expectedRecoveryDigest, ...options,
  });
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("explicit profile history expansion", () => {
  it.each([1, 2] as const)("retains exact V%s bytes and scanner settings without initializing history", async (version) => {
    const root = await repository(), old = await legacy(root, version);
    const before = await buildProgrammaticProfileProposal(root);
    await expect(requireRecommendationHistoryPolicy(root, sha256(old))).rejects.toThrow(/not approved/);
    const proposal = await buildProgrammaticProfileProposal(root, { offerHistory: true });
    expect(proposal.historyPolicy).toEqual({ version: 1, enabled: true });
    expect(proposal.configurationFingerprint).toEqual(before.configurationFingerprint);
    expect(proposal.profile).toEqual(before.profile);
    expect(await readFile(path.join(root, profilePath))).toEqual(old);
    expect((await upgrade(root)).ok).toBe(true);
    expect(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH))).toEqual(old);
    const stored = (await loadApprovedProgrammaticProfile(root))!;
    expect(stored.envelope.version).toBe(3);
    expect(stored.envelope.profile).toEqual(before.profile);
    await expect(requireRecommendationHistoryPolicy(root, sha256(stored.bytes))).resolves.toBeUndefined();
    await expect(requireRecommendationHistoryPolicy(root, sha256(old))).rejects.toThrow(/not approved/);
    await expect(readFile(path.join(root, ".gg/programmatic/recommendations.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await buildProgrammaticProfileProposal(root)).operation).toBe("current");
  });
  it("legacy approvals do not opt in and expanded approvals require recovery expectations", async () => {
    const root = await repository(); await legacy(root);
    const proposal = await buildProgrammaticProfileProposal(root);
    expect((await loadApprovedProgrammaticProfile(root))!.envelope.version).toBe(2);
    await expect(persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
      expectedPriorProfileDigest: proposal.expectedPriorProfileDigest, historyPolicy: { version: 1, enabled: true },
    })).rejects.toThrow(/recovery expectation/);
  });
  it("initial reviewed setup includes automatic history consent but saves no recommendations", async () => {
    const root = await repository();
    const review = new ProgrammaticSetupReview({ cwd: root, owner: () => "owner", assertAllowed: () => {}, reviewer: async (request) => {
      expect(request.questions[0]!.detail).toContain("automatically saves future configured assessments");
      expect(request.questions[0]!.detail).toContain('"historyPolicy"');
      return { action: "answer", answers: { [request.questions[0]!.id]: "save-setup" } };
    } });
    const proposal = await review.inspect(new AbortController().signal);
    await expect(readFile(path.join(root, profilePath))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await review.generate({ configuration_fingerprint: proposal.configurationFingerprint, profile: proposal.profile,
      expected_prior_profile_digest: proposal.expectedPriorProfileDigest }, new AbortController().signal, {});
    expect(result.ok).toBe(true); expect((await loadApprovedProgrammaticProfile(root))!.envelope.version).toBe(3);
    await expect(readFile(path.join(root, ".gg/programmatic/recommendations.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("denial leaves current legacy scanners usable and does not write recovery", async () => {
    const root = await repository(), old = await legacy(root);
    const review = new ProgrammaticSetupReview({ cwd: root, owner: () => "owner", assertAllowed: () => {},
      reviewer: async (request) => ({ action: "answer", answers: { [request.questions[0]!.id]: "deny" } }) });
    const proposal = await review.inspect(new AbortController().signal);
    expect(proposal.operation).toBe("history-upgrade");
    expect((await review.generate({ configuration_fingerprint: proposal.configurationFingerprint, profile: proposal.profile,
      expected_prior_profile_digest: proposal.expectedPriorProfileDigest }, new AbortController().signal, {})).ok).toBe(false);
    expect(await readFile(path.join(root, profilePath))).toEqual(old);
    expect((await buildProgrammaticProfileProposal(root)).operation).toBe("current");
    await expect(readFile(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([PROGRAMMATIC_PREVIOUS_PROFILE_PATH, profilePath])("interruption replacing %s keeps prior profile authoritative", async (file) => {
    const root = await repository(), old = await legacy(root);
    await expect(upgrade(root, { operations: { rename: async (from, to) => {
      if (path.basename(to) === path.basename(file)) throw new Error("Injected interruption"); await rename(from, to);
    } } })).rejects.toThrow(/interruption/);
    expect(await readFile(path.join(root, profilePath))).toEqual(old);
    if (file === profilePath) expect(await readFile(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH))).toEqual(old);
  });
  it("refuses conflicting recovery and stale approval without modifying history", async () => {
    const root = await repository(), old = await legacy(root);
    const proposal = await buildProgrammaticProfileProposal(root, { offerHistory: true });
    const different = JSON.parse(old.toString("utf8"));
    await writeFile(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH), JSON.stringify(different, null, 4));
    await expect(upgrade(root)).rejects.toThrow(/Conflicting/);
    await expect(persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
      historyPolicy: proposal.historyPolicy, expectedRecoveryDigest: proposal.expectedRecoveryDigest,
      expectedPriorProfileDigest: proposal.expectedPriorProfileDigest,
    })).rejects.toThrow(/recovery file changed/);
    expect(await readFile(path.join(root, profilePath))).toEqual(old);
  });
  it("rejects directory recovery and preserves unknown history bytes during upgrade", async () => {
    const root = await repository(); await legacy(root);
    await mkdir(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH));
    await expect(upgrade(root)).rejects.toThrow(/safe file/);
    await rm(path.join(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH), { recursive: true });
    await writeFile(path.join(root, ".gg/programmatic/recommendations.json"), '{"version":999}');
    expect((await upgrade(root)).ok).toBe(true);
    expect(await readFile(path.join(root, ".gg/programmatic/recommendations.json"), "utf8")).toBe('{"version":999}');
  });
});
