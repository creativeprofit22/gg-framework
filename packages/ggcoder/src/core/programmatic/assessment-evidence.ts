import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { canonicalRepositoryRoot } from "../tauri-package/paths.js";
import { validateProgrammaticFile, walkProgrammaticPaths } from "./inventory.js";

export const ASSESSMENT_EVIDENCE_LIMITS = Object.freeze({
  maxPaths: 200,
  /** Walk cap for ranking; the sample keeps only the best maxPaths of these. */
  maxWalkedPaths: 20_000,
  maxExcerpts: 12,
  maxExcerptBytes: 16 * 1024,
  maxDeliveredBytes: 64 * 1024,
});

type DiagnosticCode =
  | "path-limit"
  | "excerpt-limit"
  | "excerpt-truncated"
  | "delivery-limit"
  | "unreadable-or-unsafe"
  | "walk-failed"
  | "non-text"
  | "permission-denied";
export interface ProgrammaticAssessmentEvidence {
  version: 1;
  /** A sampled overview, never a fingerprint inventory or evidence receipt. */
  paths: {
    path: string;
    coverage:
      "uninspected" | "inspected" | "budget-limited" | "unreadable-or-unsafe" | "nonmatching";
  }[];
  excerpts: { path: string; text: string; truncated: boolean }[];
  diagnostics: { code: DiagnosticCode; count: number }[];
  exclusions: "programmatic-inventory-and-root-gitignore";
}

export type AssessmentEvidenceRequest =
  | { name: "find"; args: { pattern: string } }
  | { name: "read"; args: { file_path: string; limit: number } };
export interface AssessmentEvidenceAuthorization {
  authorize(request: AssessmentEvidenceRequest): Promise<boolean>;
  /** Synchronous live-policy check after awaits and before delivery. */
  isAllowed(request: AssessmentEvidenceRequest): boolean;
}
export interface AssessmentEvidenceOptions {
  signal?: AbortSignal;
  authorization?: AssessmentEvidenceAuthorization;
  /** Listed but never excerpted, e.g. command files the model can open on demand. */
  skipExcerpt?: (repositoryPath: string) => boolean;
}

const MANIFESTS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "mix.exs",
  "pubspec.yaml",
  "package.swift",
  "cmakelists.txt",
]);
const TASK_RUNNERS = new Set([
  "makefile",
  "gnumakefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "rakefile",
  "noxfile.py",
  "tox.ini",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "dockerfile",
  "jenkinsfile",
]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "package.resolved",
]);
const CI =
  /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|\.buildkite\/[^/]+\.ya?ml)$/i;
const COMMAND_FILE = /^\.(gg|claude)\/commands\/.+\.md$/i;
const DOC = /^(readme|contributing|agents|claude)(\.[a-z]+)?$/i;
const CONFIG = /\.(json|jsonc|ya?ml|toml|ini|cfg)$/i;

/** Workflow signal first: root manifests/CI, nested manifests, commands, docs, config, rest, lockfiles. */
function workflowTier(repositoryPath: string, skip: boolean): number {
  const segments = repositoryPath.split("/");
  const name = segments.at(-1)!.toLowerCase();
  const depth = segments.length - 1;
  if (LOCKFILES.has(name)) return 6;
  const build = MANIFESTS.has(name) || TASK_RUNNERS.has(name) || /\.(csproj|sln|mk)$/.test(name);
  if ((build && depth === 0) || CI.test(repositoryPath)) return 0;
  if (build) return 1;
  if (skip || COMMAND_FILE.test(repositoryPath)) return 2;
  if (depth <= 1 && (DOC.test(name) || (depth === 0 && name.endsWith(".md")))) return 3;
  if (depth <= 1 && (CONFIG.test(name) || segments[0] === "scripts")) return 4;
  return 5;
}
const traversal: AssessmentEvidenceRequest = { name: "find", args: { pattern: "**/*" } };
const readRequest = (file_path: string): AssessmentEvidenceRequest => ({
  name: "read",
  args: { file_path, limit: ASSESSMENT_EVIDENCE_LIMITS.maxExcerptBytes + 1 },
});
class EvidenceDenied extends Error {}
function checkAuthorization(
  authorization: AssessmentEvidenceAuthorization | undefined,
  request: AssessmentEvidenceRequest,
) {
  if (authorization && !authorization.isAllowed(request)) throw new EvidenceDenied();
}

/** Recheck immediately before delivery as other host work may have awaited since collection. */
export function recheckAssessmentEvidence(
  evidence: ProgrammaticAssessmentEvidence,
  authorization?: AssessmentEvidenceAuthorization,
) {
  if (!authorization) return;
  const traversalAllowed = authorization.isAllowed(traversal);
  const denied = evidence.excerpts.filter(
    (item) => !traversalAllowed || !authorization.isAllowed(readRequest(item.path)),
  );
  evidence.excerpts = evidence.excerpts.filter((item) => !denied.includes(item));
  for (const item of evidence.paths)
    if (denied.some((excerpt) => excerpt.path === item.path)) item.coverage = "uninspected";
  if (!traversalAllowed) evidence.paths = [];
  if (
    (!traversalAllowed || denied.length) &&
    !evidence.diagnostics.some((item) => item.code === "permission-denied")
  )
    evidence.diagnostics.push({ code: "permission-denied", count: Math.max(1, denied.length) });
}

/** Prefix-only read; no project imports, execution, or full-source buffering. */
async function readPrefix(
  root: string,
  repositoryPath: string,
  signal?: AbortSignal,
  authorization?: AssessmentEvidenceAuthorization,
) {
  const request = readRequest(repositoryPath);
  if (authorization && !(await authorization.authorize(request))) throw new EvidenceDenied();
  const check = () => {
    checkAuthorization(authorization, traversal);
    checkAuthorization(authorization, request);
  };
  check();
  signal?.throwIfAborted();
  const absolutePath = await validateProgrammaticFile(root, repositoryPath);
  signal?.throwIfAborted();
  const before = await lstat(absolutePath);
  check();
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino)
      throw new Error("File changed");
    signal?.throwIfAborted();
    const buffer = Buffer.alloc(ASSESSMENT_EVIDENCE_LIMITS.maxExcerptBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      check();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    signal?.throwIfAborted();
    await validateProgrammaticFile(root, repositoryPath);
    const after = await lstat(absolutePath);
    const final = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    )
      throw new Error("File changed");
    const truncated = length > ASSESSMENT_EVIDENCE_LIMITS.maxExcerptBytes;
    const bytes = buffer.subarray(0, Math.min(length, ASSESSMENT_EVIDENCE_LIMITS.maxExcerptBytes));
    // Fatal UTF-8 decoding rejects unfamiliar binary formats, not unfamiliar names.
    // stream=true drops only an incomplete trailing codepoint at a truncated boundary.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      return { nonText: true as const };
    }
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
        return { nonText: true as const };
    }
    check();
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

/** Read-only, stack-neutral initial evidence. Abort rejects; partial evidence is never an inventory. */
export async function collectProgrammaticAssessmentEvidence(
  repositoryRoot: string,
  options: AssessmentEvidenceOptions = {},
): Promise<ProgrammaticAssessmentEvidence> {
  const { signal, authorization } = options;
  const skipExcerpt = options.skipExcerpt ?? (() => false);
  signal?.throwIfAborted();
  const result: ProgrammaticAssessmentEvidence = {
    version: 1,
    paths: [],
    excerpts: [],
    diagnostics: [],
    exclusions: "programmatic-inventory-and-root-gitignore",
  };
  const diagnose = (code: DiagnosticCode, count = 1) => {
    const diagnostic = result.diagnostics.find((item) => item.code === code);
    if (diagnostic) diagnostic.count += count;
    else result.diagnostics.push({ code, count });
  };
  // Reserve space for all fixed diagnostic codes and coverage state changes.
  const fits = () =>
    Buffer.byteLength(JSON.stringify(result)) <=
    ASSESSMENT_EVIDENCE_LIMITS.maxDeliveredBytes - 1024;
  let root: string;
  let gitignoreLines: string[] = [];
  try {
    if (authorization && !(await authorization.authorize(traversal))) throw new EvidenceDenied();
    checkAuthorization(authorization, traversal);
    root = await canonicalRepositoryRoot(repositoryRoot);
    signal?.throwIfAborted();
    // A missing file is allowed; every other failure prevents discovery under an unknown policy.
    const exists = await lstat(`${root}/.gitignore`).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      const ignore = await readPrefix(root, ".gitignore", signal, authorization);
      if (ignore.nonText || ignore.truncated) throw new Error("Unsafe or oversized ignore policy");
      gitignoreLines = ignore.text.split(/\r?\n/);
    }
  } catch (error) {
    signal?.throwIfAborted();
    diagnose(error instanceof EvidenceDenied ? "permission-denied" : "unreadable-or-unsafe");
    if (!(error instanceof EvidenceDenied)) diagnose("walk-failed");
    return result;
  }
  const walked: { path: string; unsafe: boolean; tier: number; depth: number }[] = [];
  try {
    checkAuthorization(authorization, traversal);
    for await (const entry of walkProgrammaticPaths(root, { signal, gitignoreLines })) {
      signal?.throwIfAborted();
      checkAuthorization(authorization, traversal);
      if (walked.length === ASSESSMENT_EVIDENCE_LIMITS.maxWalkedPaths) {
        diagnose("path-limit");
        break;
      }
      walked.push({
        path: entry.path,
        unsafe: entry.kind === "unsafe",
        tier: workflowTier(entry.path, skipExcerpt(entry.path)),
        depth: entry.path.split("/").length - 1,
      });
    }
  } catch (error) {
    signal?.throwIfAborted();
    diagnose(error instanceof EvidenceDenied ? "permission-denied" : "walk-failed");
  }
  // Deterministic rank, independent of walk order: tier, then shallower, then ordinal path.
  walked.sort(
    (a, b) =>
      a.tier - b.tier || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  if (
    walked.length > ASSESSMENT_EVIDENCE_LIMITS.maxPaths &&
    !result.diagnostics.some((item) => item.code === "path-limit")
  )
    diagnose("path-limit");
  for (const entry of walked.slice(0, ASSESSMENT_EVIDENCE_LIMITS.maxPaths)) {
    result.paths.push({
      path: entry.path,
      coverage: entry.unsafe ? "unreadable-or-unsafe" : "uninspected",
    });
    if (!fits()) {
      result.paths.pop();
      diagnose("delivery-limit");
      break;
    }
    if (entry.unsafe) diagnose("unreadable-or-unsafe");
  }
  // Name-independent selection: extensionless and unknown source participate equally.
  let attempts = 0;
  for (const item of result.paths) {
    signal?.throwIfAborted();
    if (item.coverage !== "uninspected" || skipExcerpt(item.path)) continue;
    if (attempts++ >= ASSESSMENT_EVIDENCE_LIMITS.maxExcerpts) {
      item.coverage = "budget-limited";
      diagnose("excerpt-limit");
      continue;
    }
    try {
      const read = await readPrefix(root, item.path, signal, authorization);
      signal?.throwIfAborted();
      if (read.nonText) {
        item.coverage = "nonmatching";
        diagnose("non-text");
        continue;
      }
      const excerpt = { path: item.path, text: read.text, truncated: read.truncated };
      result.excerpts.push(excerpt);
      if (!fits()) {
        // Account for JSON escaping and UTF-8, not just source bytes.
        let low = 0,
          high = excerpt.text.length;
        const text = excerpt.text;
        excerpt.truncated = true;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          excerpt.text = text.slice(0, mid);
          if (fits()) low = mid;
          else high = mid - 1;
        }
        excerpt.text = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
        diagnose("delivery-limit");
        if (!excerpt.text || !fits()) {
          result.excerpts.pop();
          item.coverage = "budget-limited";
          continue;
        }
      }
      item.coverage = "inspected";
      if (excerpt.truncated) diagnose("excerpt-truncated");
    } catch (error) {
      signal?.throwIfAborted();
      item.coverage = error instanceof EvidenceDenied ? "uninspected" : "unreadable-or-unsafe";
      diagnose(error instanceof EvidenceDenied ? "permission-denied" : "unreadable-or-unsafe");
    }
  }
  signal?.throwIfAborted();
  recheckAssessmentEvidence(result, authorization);
  return result;
}
