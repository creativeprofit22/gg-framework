import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "@kenkaiiii/gg-core";
import { recommendationCommitUnknown, readRecommendationHistory, RECOMMENDATION_HISTORY_PATH as primary,
  RECOMMENDATION_PREVIOUS_PATH as previous, updateRecommendationHistory } from "./recommendation-history.js";
import { reconcileRecommendations, decideRecommendation, type CapturedRecommendationAssessment } from "./recommendations.js";
import { type RecommendationHistoryV1 } from "./recommendation-contracts.js";

const roots: string[] = [], at = "2026-09-16T00:00:00.000Z";
const profile = ".gg/programmatic/profile.json";
const policyBytes = '{"fixturePolicy":"explicitly-approved"}';
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-recommendation-history-")); roots.push(root);
  await mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  await writeFile(path.join(root, profile), policyBytes);
  await writeFile(path.join(root, ".gg/programmatic/state.json"), "legacy scanner bytes\n");
  return root;
}
// The low-level store requires a fresh authorization callback; production V3 policy integration is separate.
async function authorize(root: string) {
  if (await readFile(path.join(root, profile), "utf8") !== policyBytes) throw new Error("Policy changed");
}
function captured(): CapturedRecommendationAssessment {
  return { assessment: { version: 1, id: randomUUID(), startedAt: at, finishedAt: at, mode: "configured", outcome: "completed", hostCoverage: [] },
    observations: [{ version: 1, outcome: "Review counts", rationale: "Bounded review", uncertainty: "Not verified",
      workflow: { trigger: "Counts change", representativeCase: "New entry", inputs: ["Counts"], currentProcess: ["Review"], output: "Report",
        successCheck: "Compare entries", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only",
        repeatability: { basis: "inferred", explanation: "Counts can change" } }, choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: [] }] };
}
const add = (input = captured()) => (history: RecommendationHistoryV1) => reconcileRecommendations(history, input).history;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("separate recommendation file persistence", () => {
  it("persists, retries without consuming revision, retains decisions and leaves scanner bytes unchanged", async () => {
    const root = await repository(), input = captured();
    expect(await readRecommendationHistory(root)).toEqual({ status: "missing" });
    const saved = await updateRecommendationHistory(root, authorize, add(input));
    const bytes = await readFile(path.join(root, primary));
    expect(await updateRecommendationHistory(root, authorize, add(input))).toEqual({ history: saved.history, changed: false });
    expect(await readFile(path.join(root, primary))).toEqual(bytes);
    const candidate = saved.history.candidates[0]!;
    await updateRecommendationHistory(root, authorize, (history) => decideRecommendation(history,
      { candidateId: candidate.id, expectedRevision: candidate.revision, decision: "completed" }, at));
    await updateRecommendationHistory(root, authorize, add());
    const reopened = await readRecommendationHistory(root);
    expect(reopened.status).toBe("ready");
    if (reopened.status !== "ready") throw new Error("Expected history");
    expect(reopened.history.decisions[0]!.decision).toBe("completed");
    expect(reopened.history.candidates).toHaveLength(1);
    expect(await readFile(path.join(root, ".gg/programmatic/state.json"), "utf8")).toBe("legacy scanner bytes\n");
  });
  it("serializes concurrent assessments and revision-guarded human decisions", async () => {
    const root = await repository();
    await Promise.all(Array.from({ length: 5 }, () => updateRecommendationHistory(root, authorize, add())));
    const loaded = await readRecommendationHistory(root);
    if (loaded.status !== "ready") throw new Error("Expected history");
    expect(loaded.history.revision).toBe(5); expect(loaded.history.assessments).toHaveLength(5);
    const candidate = loaded.history.candidates[0]!;
    const results = await Promise.allSettled(["dismissed", "completed"].map((decision) => updateRecommendationHistory(root, authorize,
      (history) => decideRecommendation(history, { candidateId: candidate.id, expectedRevision: candidate.revision,
        decision: decision as "dismissed" | "completed" }, at))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("waits for the real profile lock then observes a revoked policy", async () => {
    const root = await repository();
    let announce!: () => void, release!: () => void;
    const acquired = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const profileWriter = withFileLock(path.join(root, profile), async () => {
      announce(); await gate; await writeFile(path.join(root, profile), "revoked");
    });
    await acquired;
    const saving = updateRecommendationHistory(root, authorize, add());
    const rejected = expect(saving).rejects.toThrow("Policy changed");
    release(); await profileWriter; await rejected;
    expect(await readRecommendationHistory(root)).toEqual({ status: "missing" });
  });
  it("refuses a retired owner during the final asynchronous temporary-file validation", async () => {
    const root = await repository();
    let live = true, reads = 0;
    const assertCurrent = () => { if (!live) throw new Error("Owner retired before rename"); };
    const options = { assertCurrent, operations: { readFile: async (file: string) => {
      const bytes = await readFile(file);
      if (path.basename(file) === ".recommendations.tmp" && ++reads === 2) live = false;
      return bytes;
    } } };
    await expect(updateRecommendationHistory(root, async (cwd) => { assertCurrent(); await authorize(cwd); }, add(), options))
      .rejects.toThrow("Owner retired before rename");
    expect(await readRecommendationHistory(root)).toEqual({ status: "missing" });
  });
  it("refuses a changed temporary document after pre-mutation callbacks", async () => {
    const root = await repository();
    await expect(updateRecommendationHistory(root, authorize, add(), { onPreFileMutation: async (file) => {
      if (file === primary) await writeFile(path.join(root, ".gg/programmatic/.recommendations.tmp"), "corrupt");
    } })).rejects.toThrow();
    expect(await readRecommendationHistory(root)).toEqual({ status: "missing" });
  });
  it("revalidates policy and primary after pre-mutation hooks", async () => {
    const root = await repository();
    await expect(updateRecommendationHistory(root, authorize, add(), { onPreFileMutation: async () => {
      await writeFile(path.join(root, profile), "revoked");
    } })).rejects.toThrow("Policy changed");
    expect(await readRecommendationHistory(root)).toEqual({ status: "missing" });
  });
  it("recovers previous on read without repair, refuses corrupt and unsupported state", async () => {
    const root = await repository();
    const first = await updateRecommendationHistory(root, authorize, add());
    await updateRecommendationHistory(root, authorize, add());
    await writeFile(path.join(root, primary), "broken");
    expect(await readRecommendationHistory(root)).toEqual({ status: "recovered", history: first.history });
    await expect(updateRecommendationHistory(root, authorize, add())).rejects.toThrow(/recovery/);
    expect(await readFile(path.join(root, primary), "utf8")).toBe("broken");
    await writeFile(path.join(root, primary), '{"version":999}');
    expect((await readRecommendationHistory(root)).status).toBe("unavailable");
    await expect(updateRecommendationHistory(root, authorize, add())).rejects.toThrow(/Unsupported/);
    await writeFile(path.join(root, primary), "broken"); await writeFile(path.join(root, previous), "also broken");
    expect((await readRecommendationHistory(root)).status).toBe("unavailable");
    await expect(updateRecommendationHistory(root, authorize, add())).rejects.toThrow(/recovery/);
  });
  it.each([previous, primary])("preserves a complete primary on interruption before replacing %s", async (file) => {
    const root = await repository(); await updateRecommendationHistory(root, authorize, add());
    const bytes = await readFile(path.join(root, primary));
    await expect(updateRecommendationHistory(root, authorize, add(), { operations: { rename: async (from, to) => {
      if (path.basename(to) === path.basename(file)) throw new Error("Injected interrupted rename");
      return rename(from, to);
    } } })).rejects.toThrow(/interrupted/);
    expect(await readFile(path.join(root, primary))).toEqual(bytes);
  });
  it.each(["notification", "rename-acknowledgement", "cleanup"])("reports %s failure after primary rename as committed/unknown", async (failure) => {
    const root = await repository(); let renamed = false;
    let error: unknown;
    try {
      await updateRecommendationHistory(root, authorize, add(), {
        onFileMutated: (file) => { if (file === primary && failure === "notification") throw new Error("Notification failure"); },
        operations: {
          rename: async (from, to) => {
            await rename(from, to); if (path.basename(to) === path.basename(primary)) { renamed = true; if (failure === "rename-acknowledgement") throw new Error("Lost acknowledgement"); }
          },
          rm: async (file, options) => { if (renamed && failure === "cleanup") throw new Error("Cleanup failure"); await rm(file, options); },
        },
      });
    } catch (caught) { error = caught; }
    expect(recommendationCommitUnknown(error)).toBe(true);
    expect((await readRecommendationHistory(root)).status).toBe("ready");
  });
  it("cancellation before primary commit retains saved bytes", async () => {
    const root = await repository(); await updateRecommendationHistory(root, authorize, add());
    const bytes = await readFile(path.join(root, primary)), controller = new AbortController();
    await expect(updateRecommendationHistory(root, authorize, add(), { signal: controller.signal,
      onPreFileMutation: (file) => { if (file === primary) controller.abort(); } })).rejects.toThrow();
    expect(await readFile(path.join(root, primary))).toEqual(bytes);
  });
  it("refuses record capacity without evicting history", async () => {
    const root = await repository();
    const first = await updateRecommendationHistory(root, authorize, add());
    const full = structuredClone(first.history);
    for (let i = full.assessments.length; i < 4_096; i++) full.assessments.push({ ...captured().assessment, observationIds: [] });
    await writeFile(path.join(root, primary), JSON.stringify(full));
    const bytes = await readFile(path.join(root, primary));
    await expect(updateRecommendationHistory(root, authorize, add())).rejects.toThrow();
    expect(await readFile(path.join(root, primary))).toEqual(bytes);
  });
  it("refuses nonregular destinations and linked parent directories", async () => {
    const root = await repository(); await mkdir(path.join(root, primary));
    expect((await readRecommendationHistory(root)).status).toBe("unavailable");
    await expect(updateRecommendationHistory(root, authorize, add())).rejects.toThrow();
    const other = await repository(), linked = await mkdtemp(path.join(os.tmpdir(), "gg-recommendation-linked-")); roots.push(linked);
    await symlink(path.join(other, ".gg"), path.join(linked, ".gg"), "junction");
    expect((await readRecommendationHistory(linked)).status).toBe("unavailable");
    await expect(updateRecommendationHistory(linked, authorize, add())).rejects.toThrow();
    expect(await readRecommendationHistory(other)).toEqual({ status: "missing" });
  });
  it("reopens real history in a fresh process and times read-only previous recovery", async () => {
    const root = await repository(); await updateRecommendationHistory(root, authorize, add()); await updateRecommendationHistory(root, authorize, add());
    await writeFile(path.join(root, primary), "interrupted bytes");
    const moduleUrl = new URL("./recommendation-history.ts", import.meta.url).href;
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const started = performance.now();
    const result = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e",
      `import { readRecommendationHistory } from ${JSON.stringify(moduleUrl)}; const result = await readRecommendationHistory(process.argv[1]); console.log(JSON.stringify({status:result.status, revision:result.history?.revision}));`, root]);
    const elapsedMs = Math.round(performance.now() - started);
    expect(JSON.parse(result.stdout)).toEqual({ status: "recovered", revision: 1 });
    expect(await readFile(path.join(root, primary), "utf8")).toBe("interrupted bytes");
    console.info(`Recommendation temporary restore/reopen drill: revision=1 elapsedMs=${elapsedMs}; read-only recovery, no repair or disk-loss guarantee.`);
  });
});
