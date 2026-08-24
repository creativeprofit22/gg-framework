#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "..", "..");
const MAX_MANIFEST_BYTES = 1024 * 1024;
export const DECISION_SUMMARY_CONTEXT_MAX_BYTES = 64 * 1024;
export const DECISION_SUMMARY_DIFF_MAX_BYTES = 12 * 1024;
export const DECISION_SUMMARY_MAX_DECISIONS = 20;
export const DECISION_SUMMARY_MAX_FILES = 40;

export function classifyBlobOutcome({ base, local, upstream, merged }) {
  if (merged === undefined || local === undefined || upstream === undefined) return "unresolved";
  if (local === base || upstream === base || local === upstream) return "unresolved";
  if (merged === local) return "kept-local";
  if (merged === upstream) return "adopted-upstream";
  return "combined";
}

export function fallbackDecisionSummary(decisions) {
  const count = (outcome) => decisions.filter((decision) => decision.outcome === outcome).length;
  const area = (total) => (total === 1 ? "one area" : `${total} areas`);
  const sentences = [];
  const local = count("kept-local");
  const upstream = count("adopted-upstream");
  const combined = count("combined");
  const unresolved = count("unresolved");
  if (local) {
    sentences.push(
      `It held onto your local work in ${area(local)} because the finished update uses your ${local === 1 ? "version" : "versions"} there.`,
    );
  }
  if (upstream) {
    sentences.push(
      `It brought in upstream's work in ${area(upstream)} because the finished update uses ${upstream === 1 ? "that version" : "those versions"} there.`,
    );
  }
  if (combined) {
    sentences.push(
      `It blended your work with upstream in ${area(combined)}, keeping changes from both sides.`,
    );
  }
  if (unresolved) {
    sentences.push(
      `It left ${area(unresolved)} marked for review because the result did not point cleanly to either side.`,
    );
  }
  return sentences.length === 0
    ? "Your protected update completed successfully."
    : `Your protected update is ready. ${sentences.join(" ")}`;
}

export function isDecisionNoise(path) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.(?:toml|lock))$/.test(
      normalized,
    ) ||
    /(?:^|\/)(?:local-)?changelog(?:\.[^/]+)?$/.test(normalized) ||
    /(?:^|\/)tauri(?:\.[^/]+)?\.conf\.json$/.test(normalized) ||
    /(?:^|\/)version(?:\.[^/]+)?$/.test(normalized)
  );
}

function changeArea(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/\.(?:test|spec)(?=\.[^/]+$)/, "")
    .replace(/\.[^/.]+$/, "");
}

export function groupDecisionAreas(files) {
  const grouped = new Map();
  for (const file of files) {
    if (isDecisionNoise(file.path)) continue;
    const area = changeArea(file.path);
    const current = grouped.get(area) ?? [];
    current.push({
      ...file,
      role: /\.(?:test|spec)\.[^/]+$/.test(file.path) ? "test" : "implementation",
    });
    grouped.set(area, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([area, areaFiles]) => {
      areaFiles.sort((left, right) =>
        left.role === right.role
          ? left.path.localeCompare(right.path)
          : left.role === "implementation"
            ? -1
            : 1,
      );
      const outcomes = new Set(areaFiles.map(({ outcome }) => outcome));
      return {
        area,
        outcome: outcomes.size === 1 ? areaFiles[0].outcome : "unresolved",
        files: areaFiles,
      };
    });
}

function git(repoRoot, args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function resolveCommit(repoRoot, revision) {
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error("Merge must be a Git object ID.");
  return git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).stdout.trim();
}

function changedPaths(repoRoot, from, to) {
  return new Set(
    git(repoRoot, ["diff", "--name-only", "-z", from, to, "--"]).stdout.split("\0").filter(Boolean),
  );
}

function objectAtPath(repoRoot, commit, path) {
  const result = git(repoRoot, ["ls-tree", "-z", commit, "--", path]);
  const entry = result.stdout.split("\0").find(Boolean);
  if (!entry) return null;
  const metadata = entry.slice(0, entry.indexOf("\t")).split(" ");
  return metadata[2] || undefined;
}

function verificationFacts(repoRoot, mergeOid) {
  const backups = join(repoRoot, ".gg", "local-fixes", "backups");
  if (!existsSync(backups))
    return { workflowVerified: false, checks: "not-recorded", installer: null };

  const matches = [];
  for (const name of readdirSync(backups)) {
    const path = join(backups, name, "manifest.json");
    if (!existsSync(path) || statSync(path).size > MAX_MANIFEST_BYTES) continue;
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      if (manifest?.mergedHead === mergeOid && manifest?.verified === true) matches.push(manifest);
    } catch {
      // Ignore malformed recovery manifests; they are not verification evidence.
    }
  }
  matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const latest = matches[0];
  if (!latest) return { workflowVerified: false, checks: "not-recorded", installer: null };
  return {
    workflowVerified: true,
    phase: latest.phase,
    recordedAt: latest.timestamp,
    // Existing manifests do not record whether checks were enabled.
    checks: "not-recorded",
    installer: latest.installer
      ? { sha256: latest.installer.sha256, size: latest.installer.size }
      : null,
  };
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: bytes
      .subarray(0, maxBytes)
      .toString("utf8")
      .replace(/\ufffd$/u, ""),
    truncated: true,
  };
}

function boundedDiff(repoRoot, from, to, path) {
  const result = git(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-color", "--unified=3", from, to, "--", path],
    true,
  );
  if ((result.status ?? 1) !== 0) return { status: "unavailable", text: "", truncated: false };
  if (/^(?:Binary files .* differ|GIT binary patch)$/mu.test(result.stdout)) {
    return { status: "binary", text: "", truncated: false };
  }
  return { status: "available", ...truncateUtf8(result.stdout, DECISION_SUMMARY_DIFF_MAX_BYTES) };
}

export function generateDecisionSummaryContext(repoRoot, record) {
  if (!record?.verification?.workflowVerified || !record?.verification?.recordedAt) {
    throw new Error("Decision summary context requires a verified Decision record.");
  }
  const { merge, base, localParent, upstreamParent } = record.evidence ?? {};
  for (const oid of [merge, base, localParent, upstreamParent]) {
    if (!/^[0-9a-f]{40}$/iu.test(oid ?? ""))
      throw new Error("Decision summary context requires full Git object IDs.");
  }

  const sourceDecisions = record.decisions
    .slice(0, DECISION_SUMMARY_MAX_DECISIONS)
    .map((decision) => ({
      decision,
      orderedFiles: [...decision.files].sort((left, right) =>
        left.role === right.role
          ? left.path.localeCompare(right.path)
          : left.role === "implementation"
            ? -1
            : 1,
      ),
      selectedFiles: [],
    }));
  let fileCount = 0;
  for (const source of sourceDecisions) {
    const first = source.orderedFiles.shift();
    if (first && fileCount < DECISION_SUMMARY_MAX_FILES) {
      source.selectedFiles.push(first);
      fileCount += 1;
    }
  }
  const remaining = sourceDecisions
    .flatMap((source) => source.orderedFiles.map((file) => ({ source, file })))
    .sort((left, right) =>
      left.file.role === right.file.role ? 0 : left.file.role === "implementation" ? -1 : 1,
    );
  for (const { source, file } of remaining.slice(0, DECISION_SUMMARY_MAX_FILES - fileCount)) {
    source.selectedFiles.push(file);
    fileCount += 1;
  }
  let truncated =
    record.decisions.length > sourceDecisions.length ||
    sourceDecisions.some(
      ({ decision, selectedFiles }) => selectedFiles.length < decision.files.length,
    );
  const decisions = sourceDecisions.map(({ decision, selectedFiles }) => ({
    area: decision.area,
    outcome: decision.outcome,
    files: selectedFiles.map((file) => ({
      path: file.path,
      role: file.role,
      diffs: {
        baseToLocal: boundedDiff(repoRoot, base, localParent, file.path),
        baseToUpstream: boundedDiff(repoRoot, base, upstreamParent, file.path),
        baseToMerged: boundedDiff(repoRoot, base, merge, file.path),
      },
    })),
  }));

  const context = {
    version: 1,
    recordedAt: record.verification.recordedAt,
    evidence: { merge, base, localParent, upstreamParent },
    truncated,
    decisions,
  };
  const diffs = decisions
    .flatMap((decision) => decision.files.flatMap((file) => Object.values(file.diffs)))
    .reverse();
  const serializedBytes = () => Buffer.byteLength(`${JSON.stringify(context, null, 2)}\n`, "utf8");
  while (serializedBytes() > DECISION_SUMMARY_CONTEXT_MAX_BYTES) {
    const diff = diffs.find((candidate) => candidate.text.length > 0);
    if (!diff) throw new Error("Decision summary metadata exceeds its byte limit.");
    const excess = serializedBytes() - DECISION_SUMMARY_CONTEXT_MAX_BYTES;
    diff.text = truncateUtf8(
      diff.text,
      Math.max(0, Buffer.byteLength(diff.text, "utf8") - excess - 64),
    ).text;
    diff.truncated = true;
    context.truncated = true;
  }
  return context;
}

export function generateDecisionRecord(repoRoot, revision) {
  const merge = resolveCommit(repoRoot, revision);
  const parentLine = git(repoRoot, ["rev-list", "--parents", "-n", "1", merge]).stdout.trim();
  const [, localParent, upstreamParent, ...extraParents] = parentLine.split(" ");
  if (!localParent || !upstreamParent || extraParents.length > 0) {
    throw new Error("Decision evidence requires an ordinary two-parent merge commit.");
  }
  const base = git(repoRoot, ["merge-base", localParent, upstreamParent]).stdout.trim();
  const localPaths = changedPaths(repoRoot, base, localParent);
  const upstreamPaths = changedPaths(repoRoot, base, upstreamParent);
  const overlapPaths = [...localPaths].filter((path) => upstreamPaths.has(path)).sort();

  // simplification: v2 classifies whole-path blobs and known metadata paths; add hunk provenance
  // when meaningful manifest/config changes must be separated from release noise.
  const overlapFiles = overlapPaths.map((path) => {
    const blobs = {
      base: objectAtPath(repoRoot, base, path),
      local: objectAtPath(repoRoot, localParent, path),
      upstream: objectAtPath(repoRoot, upstreamParent, path),
      merged: objectAtPath(repoRoot, merge, path),
    };
    return { path, outcome: classifyBlobOutcome(blobs), blobs };
  });
  const decisions = groupDecisionAreas(overlapFiles);

  return {
    schemaVersion: 2,
    id: `decision-${merge.slice(0, 12)}`,
    date: git(repoRoot, ["show", "-s", "--format=%cs", merge]).stdout.trim(),
    label: git(repoRoot, ["show", "-s", "--format=%s", merge]).stdout.trim(),
    evidence: { merge, base, localParent, upstreamParent },
    verification: verificationFacts(repoRoot, merge),
    decisions,
  };
}

function parseArgs(args) {
  let merge;
  let repoRoot = defaultRepoRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--merge") merge = args[++index];
    else if (args[index] === "--repo") repoRoot = resolve(args[++index] ?? "");
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (!merge) throw new Error("Usage: decisions-classifier.mjs --merge <oid> [--repo <path>]");
  return { merge, repoRoot };
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { merge, repoRoot } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(generateDecisionRecord(repoRoot, merge), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
