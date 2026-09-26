import { randomUUID } from "node:crypto";
import { withFileLock } from "@kenkaiiii/gg-core";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AskUserBridge, AskUserRequest, AskUserResult } from "../ask-user.js";
import { discoverCommands, type CommandDiscoveryOptions } from "../command-discovery.js";
import { getGlobalCommandDirs } from "../custom-commands.js";
import { PROMPT_COMMANDS } from "../prompt-commands.js";
import { parseSkillFile } from "../skills.js";
import { canonicalRepositoryRoot, containedPath, sha256, stableJson } from "../tauri-package/paths.js";
import { ADVISORY_LIMITS } from "./advisory.js";
import { programmaticCreationProposalV1Schema, programmaticMissingCapabilityV1Schema, repositoryRelativePathSchema } from "./contracts.js";

const LIMITS = { fileBytes: 128_000, totalBytes: 512_000, previewBytes: 64_000, files: 33 } as const;
const text = z.string().min(1).max(LIMITS.fileBytes);
const note = z.string().trim().min(1).max(4_000);
const safeName = z.string().max(80).regex(/^[a-z][a-z0-9-]*$/).refine((name) =>
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name), "reserved device name");
const helperName = z.string().max(100).regex(/^[a-z][a-z0-9-]*\.[a-z0-9]+$/).refine((name) =>
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name), "reserved device name");

export const commandInspectionInputSchema = z.strictObject({
  name: safeName,
  requirement: programmaticMissingCapabilityV1Schema,
  markdown: text,
  helpers: z.array(z.strictObject({ name: helperName, content: text, repeatableLogic: note })).max(32).default([]),
  requiredTools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(100)).max(100),
  /** Installed project packages needed by helpers; no install or import is performed. */
  packages: z.array(z.string().max(150).regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/)).max(32).default([]),
  prerequisiteFiles: z.array(repositoryRelativePathSchema.refine((file) => file.split("/").every((segment) =>
    /^[a-z0-9._@+-]+$/i.test(segment) && !/[. ]$/.test(segment) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)), "unsafe prerequisite path")).max(32).default([]),
  /** Choose likely candidates for full body inspection; metadata covers the whole bounded catalog. */
  candidates: z.array(z.string().min(1).max(100)).max(ADVISORY_LIMITS.bodies).default([]),
  review: z.strictObject({
    inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
    disposition: z.enum(["create", "reuse", "manual", "development"]),
    rationale: note,
    reuseName: z.string().min(1).max(100).optional(),
  }).optional(),
});
type Input = z.infer<typeof commandInspectionInputSchema>;
export interface CommandInspectionOptions extends CommandDiscoveryOptions {
  localFilesystem?: boolean;
  /** Host-owned, permission-filtered persistent inventory, independent of temporary turn
   * execution restrictions. Never accepted from model approval input; grants no execution. */
  availableTools: () => readonly string[];
}
type Catalog = {
  sha256: string;
  entries: { name: string; aliases: string[]; source: string; description: string }[];
  candidates: { name: string; body: string | null; limitation: string }[];
};
export interface InspectedCommandProposal {
  proposal: z.infer<typeof programmaticCreationProposalV1Schema>;
  files: { path: string; content: string }[];
  inventorySha256: string;
  prerequisiteSha256: string;
  prerequisites: { path: string; sha256: string }[];
  environmentSha256: string;
  root: string;
  rootIdentity: string;
  input: Input;
  preview: string;
}
export type CommandCreationReviewer = (request: AskUserRequest, signal: AbortSignal) => Promise<AskUserResult>;

/** Desktop's existing question bridge, cancelling only this review's question. */
export function commandCreationReviewer(bridge: AskUserBridge): CommandCreationReviewer {
  return async (request, signal) => {
    signal.throwIfAborted();
    const answer = bridge.park(request);
    const cancel = () => {
      const pending = bridge.pendingRequests.find((item) => item.questions[0]?.id === request.questions[0]?.id);
      if (pending) bridge.settle(pending.id, { action: "cancel" });
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try { return await answer; } finally { signal.removeEventListener("abort", cancel); }
  };
}

export type CommandInspection =
  | { status: "proposal"; value: InspectedCommandProposal }
  | { status: "review-required"; catalog: Catalog }
  | { status: "reuse" | "manual" | "development"; reason: string; command?: string }
  | { status: "unavailable" | "conflict"; reason: string };

/** Includes all existing ancestors; a missing destination is allowed, a link is not. */
export async function commandLocalStat(absolute: string) {
  const resolved = path.resolve(absolute);
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (current !== resolved && !stat.isDirectory())) throw new Error("unsafe-path");
      if (current === resolved) return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return fs.lstat(resolved);
}
export async function readCommandText(absolute: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const before = await commandLocalStat(absolute);
  if (!before?.isFile() || before.size > LIMITS.fileBytes) throw new Error("unreadable-or-oversize-file");
  const handle = await fs.open(absolute, "r");
  try {
    const opened = await handle.stat();
    const pinned = await commandLocalStat(absolute);
    if (!pinned || opened.dev !== before.dev || opened.ino !== before.ino ||
      pinned.dev !== opened.dev || pinned.ino !== opened.ino) throw new Error("file-changed");
    const bytes = Buffer.alloc(LIMITS.fileBytes + 1);
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await commandLocalStat(absolute);
    if (!after || bytesRead > LIMITS.fileBytes || bytesRead !== opened.size || after.dev !== opened.dev ||
      after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size)
      throw new Error("file-changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
export async function commandEnvironmentSha256(): Promise<string> {
  const executable = await commandLocalStat(process.execPath);
  if (!executable?.isFile()) throw new Error("runtime-unavailable");
  // Retain hashes, never raw environment values (which can contain secrets).
  return sha256(stableJson({ executable: process.execPath, node: process.version, platform: process.platform, arch: process.arch,
    dev: executable.dev, ino: executable.ino, size: executable.size, mtime: executable.mtimeMs,
    path: process.env.PATH, nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH }));
}

function validateText(content: string) {
  const hasControl = [...content].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
  if (!content.trim() || hasControl ||
    Buffer.byteLength(content) > LIMITS.fileBytes || Buffer.from(content).toString("utf8") !== content)
    throw new Error("invalid-text");
}

export async function observeCommandSources(root: string, signal: AbortSignal, ownedPaths: ReadonlySet<string> = new Set()) {
  const claims = new Set<string>();
  const fingerprint: unknown[] = [];
  const sources: { directory: string; filePath: string; filename: string; name: string; raw: string; prompt: string; scope: "project" | "global" }[] = [];
  let bytes = 0;
  let count = 0;
  // Enumerate BEFORE the permissive loader swallows errors and deduplicates names.
  const directories = [...new Set([...getGlobalCommandDirs(), path.join(root, ".gg/commands")])];
  for (const directory of directories) {
    fingerprint.push([directory, "inventory"]);
    const stat = await commandLocalStat(directory);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error("unsafe-command-directory");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > ADVISORY_LIMITS.pages * 100) throw new Error("catalog-limit");
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      signal.throwIfAborted();
      if (ownedPaths.has(path.join(directory, entry.name))) continue;
      // Case variants also reserve destination paths on case-sensitive hosts.
      claims.add(entry.name.replace(/\.md$/i, "").toLowerCase());
      fingerprint.push([directory, entry.name, entry.isDirectory() ? "directory" : "entry"]);
      if (!/\.md$/i.test(entry.name)) continue;
      if (++count > ADVISORY_LIMITS.pages * 100) throw new Error("catalog-limit");
      const raw = await readCommandText(path.join(directory, entry.name), signal);
      bytes += Buffer.byteLength(raw);
      if (bytes > ADVISORY_LIMITS.metadataChars) throw new Error("catalog-limit");
      const scope = directory === path.join(root, ".gg/commands") ? "project" : "global";
      const parsed = parseSkillFile(raw, scope);
      const name = parsed.name || entry.name.slice(0, -3);
      claims.add(name.toLowerCase());
      fingerprint.push([directory, entry.name, sha256(raw)]);
      sources.push({ directory, filePath: path.join(directory, entry.name), filename: entry.name, name, raw, prompt: parsed.content, scope });
    }
  }
  return { claims, fingerprint, sources, directories };
}

async function inspectCatalog(root: string, input: Input, options: CommandInspectionOptions, signal: AbortSignal, ownedPaths: ReadonlySet<string>) {
  const reservedIdentities = [...new Set((options.reservedCommandIdentities ?? []).map((name) => name.toLowerCase()))].sort();
  const observed = await observeCommandSources(root, signal, ownedPaths);
  const claims = new Set<string>(["programmatic-run", ...reservedIdentities, ...observed.claims]);
  const fingerprint: unknown[] = [["reserved-command-identities", reservedIdentities], ...observed.fingerprint];
  // Include shadowed built-in/host aliases, not just the final visible list.
  const registryActions = [...(options.getRegistryActions?.() ?? options.registryActions ?? [])];
  for (const command of [...PROMPT_COMMANDS, ...(options.workspaceActions ?? []), ...registryActions]) {
    for (const name of [command.name, ...command.aliases]) claims.add(name.toLowerCase());
    fingerprint.push(command);
  }
  const discovery = await discoverCommands(root, { ...options, getRegistryActions: () => registryActions });
  const entries = discovery.entries.map(({ listing }) => ({
    name: listing.name, aliases: listing.aliases, source: listing.origin ?? listing.source, description: listing.description,
  }));
  if (entries.length > ADVISORY_LIMITS.pages * 100 || JSON.stringify(entries).length > ADVISORY_LIMITS.metadataChars)
    throw new Error("catalog-limit");
  const candidates = input.candidates.map((name) => {
    const entry = discovery.resolve(name);
    if (!entry || !discovery.entries.includes(entry)) throw new Error("candidate-unavailable");
    return { name, body: entry.custom?.prompt ?? entry.prompt?.prompt ?? null,
      limitation: "Suitability is a reviewed claim. Prompt bodies do not establish helper or app capability." };
  });
  if (Buffer.byteLength(JSON.stringify(candidates)) > LIMITS.previewBytes) throw new Error("candidate-preview-limit");
  const catalog: Catalog = { sha256: sha256(stableJson([fingerprint, entries, candidates])), entries, candidates };
  return { claims, catalog };
}

/** Read-only: no permission, publication, helper execution, model run, or package installation. */
export async function inspectCommandCreation(
  cwd: string, value: unknown, options: CommandInspectionOptions, signal: AbortSignal,
  /** Host-only current-operation files, checked separately before publication. */
  ownedPaths: ReadonlySet<string> = new Set(),
): Promise<CommandInspection> {
  if (options.localFilesystem === false) return { status: "unavailable", reason: "local-filesystem-required" };
  const parsed = commandInspectionInputSchema.safeParse(value);
  if (!parsed.success) return { status: "unavailable", reason: "invalid-request" };
  const input = parsed.data;
  if (input.requirement.capabilityKind === "app-backed")
    return { status: "development", reason: "A Markdown command cannot supply missing app/native/tool functionality." };
  try {
    signal.throwIfAborted();
    // Reject a linked supplied root before resolving it to its owner.
    if (!(await commandLocalStat(path.resolve(cwd)))?.isDirectory()) throw new Error("unsafe-project-root");
    const root = await canonicalRepositoryRoot(cwd);
    const stat = await fs.lstat(root);
    const rootIdentity = `${stat.dev}:${stat.ino}`;
    const { claims, catalog } = await inspectCatalog(root, input, options, signal, ownedPaths);
    if (!input.review || input.review.inventorySha256 !== catalog.sha256) return { status: "review-required", catalog };
    if (input.review.disposition === "reuse") {
      if (!input.review.reuseName || !catalog.candidates.some((candidate) => candidate.name === input.review!.reuseName))
        return { status: "unavailable", reason: "reuse-requires-current-candidate-inspection" };
      return { status: "reuse", command: input.review.reuseName, reason: input.review.rationale };
    }
    if (input.review.disposition !== "create") return { status: input.review.disposition, reason: input.review.rationale };
    if (claims.has(input.name.toLowerCase())) return { status: "conflict", reason: "name-alias-or-path-already-exists" };
    const tools = [...new Set(options.availableTools())].sort();
    if (input.requiredTools.some((tool) => !tools.includes(tool)))
      return { status: "unavailable", reason: "required-tool-unavailable-no-installation" };
    const prerequisites: { path: string; sha256: string }[] = [];
    for (const file of input.prerequisiteFiles)
      prerequisites.push({ path: file, sha256: sha256(await readCommandText(containedPath(root, file), signal)) });
    // Node is the current host's installed runtime. Other helper languages fail
    // closed rather than implying that a shell tool installs their interpreter.
    if (input.helpers.some((helper) => !/\.(?:mjs|cjs|js|json|txt|md)$/.test(helper.name)))
      return { status: "unavailable", reason: "helper-runtime-not-established" };
    const runtime = input.helpers.length ? { executable: process.execPath, version: process.version,
      platform: process.platform, arch: process.arch } : null;
    if (runtime && !(await commandLocalStat(runtime.executable))?.isFile())
      return { status: "unavailable", reason: "helper-runtime-unavailable" };
    for (const name of input.packages) {
      const packagePath = `node_modules/${name}/package.json`;
      const raw = await readCommandText(containedPath(root, packagePath), signal);
      const manifest = z.object({ name: z.literal(name), version: z.string().min(1).max(100) }).safeParse(JSON.parse(raw));
      if (!manifest.success) return { status: "unavailable", reason: "installed-package-unavailable" };
      prerequisites.push({ path: packagePath, sha256: sha256(raw) });
    }
    validateText(input.markdown);
    const command = parseSkillFile(input.markdown, "project");
    if ((command.name && command.name !== input.name) || !command.content.trim() ||
      (input.markdown.startsWith("---") && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(input.markdown)))
      throw new Error("malformed-command");
    for (const heading of ["Inputs", "Outputs", "Required tools", "Limits", "Arguments"]) {
      if (!new RegExp(`^#{1,6} ${heading}\\s*\\r?\\n(?!#)\\s*\\S`, "mi").test(command.content))
        throw new Error("missing-command-documentation");
    }
    if ((input.helpers.length > 0) !== (input.requirement.capabilityKind === "script-backed"))
      throw new Error("helper-capability-mismatch");
    const commandPath = `.gg/commands/${input.name}.md`;
    const helperDirectory = `.gg/commands/.${input.name}-helpers`;
    if (input.helpers.length && (claims.has(path.posix.basename(helperDirectory).toLowerCase()) ||
      (!ownedPaths.has(containedPath(root, helperDirectory)) && await commandLocalStat(containedPath(root, helperDirectory)))))
      return { status: "conflict", reason: "helper-directory-already-exists" };
    const files = [{ path: commandPath, content: input.markdown }, ...input.helpers.map((helper) => ({
      path: `${helperDirectory}/${helper.name}`, content: helper.content,
    }))].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) throw new Error("duplicate-path");
    for (const file of files) {
      validateText(file.content);
      const absolute = containedPath(root, file.path);
      if (await commandLocalStat(absolute)) {
        if (!ownedPaths.has(absolute) || await readCommandText(absolute, signal) !== file.content)
          return { status: "conflict", reason: "destination-already-exists" };
      }
    }
    if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > LIMITS.totalBytes) throw new Error("content-limit");
    const proposal = programmaticCreationProposalV1Schema.parse({
      version: 1, proposalId: randomUUID(), purpose: "creation", scope: "project", requirement: input.requirement,
      commandPath, files: files.map((file) => ({ path: file.path, proposedSha256: sha256(file.content), prior: { status: "absent" } })),
      snapshot: { version: 1, command: { version: 1, name: input.name, source: "project-custom", invocationKind: "prompt" },
        capabilityKind: input.requirement.capabilityKind, ownerSha256: sha256(`project:${containedPath(root, commandPath)}`),
        bodySha256: sha256(command.content), helpers: files.filter((file) => file.path !== commandPath)
          .map((file) => ({ path: file.path, sha256: sha256(file.content) })) },
    });
    const environmentSha256 = await commandEnvironmentSha256();
    const prerequisiteSha256 = sha256(stableJson({ tools, prerequisites, runtime, environmentSha256 }));
    const preview = JSON.stringify({ proposal, files, suitability: input.review, prerequisites, runtime, environmentSha256, requiredTools: input.requiredTools,
      helperReasons: input.helpers.map(({ name, repeatableLogic }) => ({ name, repeatableLogic })),
      limits: ["Creation only: does not execute or grant tools.", "Suitability and prose prerequisites are reviewed claims, not proven capabilities.",
        "Behavior has not been tested. No app/native capability, global promotion, overwrite, installation, or OS sandbox is supplied."],
    }, null, 2);
    if (Buffer.byteLength(preview) > LIMITS.previewBytes) throw new Error("complete-preview-exceeds-limit");
    signal.throwIfAborted();
    return { status: "proposal", value: { proposal, files, inventorySha256: catalog.sha256, prerequisiteSha256,
      root, rootIdentity, input, preview, prerequisites, environmentSha256 } };
  } catch {
    return { status: "unavailable", reason: signal.aborted ? "cancelled" : "unsafe-unreadable-invalid-or-oversize-content" };
  }
}

export interface CommandPublicationOptions extends CommandInspectionOptions {
  onPreFileMutation?: (absolutePath: string) => void | Promise<void>;
  onFileMutated?: (absolutePath: string) => void | Promise<void>;
  /** Fault boundaries for host tests only; never exposed in tool parameters. */
  onStage?: (stage: "before-helper" | "after-helper" | "before-publication" | "after-publication", file: string) => void | Promise<void>;
}

/** Command-last, atomic no-replace publication. Never a rename-overwrite fallback. */
export async function publishReviewedCommand(value: InspectedCommandProposal, options: CommandPublicationOptions, signal: AbortSignal) {
  const owned = new Map<string, { content: string; dev: number; ino: number }>();
  const directories = new Map<string, { dev: number; ino: number }>();
  const parents = new Map<string, { dev: number; ino: number }>();
  const metadata = new Map<string, { dev: number; ino: number }>();
  const ignored = new Set<string>();
  const residualPaths: string[] = [];
  const warnings: string[] = [];
  let created = false;
  let loads = false;
  const root = value.root;
  const destination = containedPath(root, value.proposal.commandPath);
  const temporary = path.join(path.dirname(destination), `.create-${randomUUID()}.pending`);
  const result = () => ({ status: created ? "created" as const : "unavailable" as const, created, loads,
    executionApproved: false as const, behavior: "not-tested" as const, command: value.proposal.snapshot.command,
    residualPaths, warnings });
  const notify = async (file: string) => {
    try { await options.onFileMutated?.(file); } catch { warnings.push("mutation-notification-failed"); }
  };
  const ensureDirectory = async (directory: string, exclusive = false) => {
    const before = await commandLocalStat(directory);
    if (before) {
      if (exclusive || !before.isDirectory()) throw new Error("directory-conflict");
      return;
    }
    await fs.mkdir(directory, { mode: 0o700 });
    const stat = await commandLocalStat(directory);
    if (!stat?.isDirectory()) throw new Error("directory-changed");
    if (exclusive) directories.set(directory, stat);
    else parents.set(directory, stat);
  };
  const stage = async (absolute: string, content: string) => {
    signal.throwIfAborted();
    await options.onPreFileMutation?.(absolute);
    if (await commandLocalStat(absolute)) throw new Error("stage-conflict");
    const handle = await fs.open(absolute, "wx", 0o600);
    try {
      const stat = await handle.stat();
      owned.set(absolute, { content, dev: stat.dev, ino: stat.ino });
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await notify(absolute);
    ignored.add(absolute);
  };
  const checkOwned = async () => {
    for (const [file, expected] of owned) {
      const stat = await commandLocalStat(file);
      if (!stat || stat.dev !== expected.dev || stat.ino !== expected.ino || await readCommandText(file, signal) !== expected.content)
        throw new Error("staged-content-changed");
    }
    for (const [directory, expected] of directories) {
      const stat = await commandLocalStat(directory);
      if (!stat || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("helper-directory-changed");
      const entries = await fs.readdir(directory);
      if (entries.some((name) => !owned.has(path.join(directory, name)))) throw new Error("unreviewed-helper-file");
    }
  };
  const cleanup = async () => {
    // Never remove the published command or its helpers, even after notification failure.
    for (const [file, expected] of [...owned].reverse()) {
      if (created && file !== temporary) continue;
      try {
        const stat = await commandLocalStat(file);
        if (!stat) continue;
        if (stat.dev !== expected.dev || stat.ino !== expected.ino || await readCommandText(file, new AbortController().signal) !== expected.content)
          throw new Error("changed-user-content");
        await fs.unlink(file); await notify(file);
      } catch { residualPaths.push(path.relative(root, file).split(path.sep).join("/")); }
    }
    for (const [directory, expected] of [...(created ? [] : [...parents, ...directories]), ...metadata].reverse()) {
      try {
        const stat = await commandLocalStat(directory);
        if (!stat) continue;
        if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("changed-directory");
        await fs.rmdir(directory);
      } catch { residualPaths.push(path.relative(root, directory).split(path.sep).join("/")); }
    }
  };
  try {
    signal.throwIfAborted();
    const initial = await inspectCommandCreation(root, value.input, options, signal);
    if (initial.status !== "proposal" || !sameCommandProposal(value, initial.value)) throw new Error("stale-proposal");
    for (const file of value.files) await options.onPreFileMutation?.(containedPath(root, file.path));
    await ensureDirectory(containedPath(root, ".gg"));
    // withFileLock removes stale/unparseable lock files. Confine it to a new,
    // operation-owned directory: it must never reclaim an existing user's file.
    // Cross-operation exclusion is supplied by exclusive helper mkdir and link.
    const lockDirectory = containedPath(root, `.gg/.command-creation-${randomUUID()}`);
    await fs.mkdir(lockDirectory, { mode: 0o700 });
    const lockStat = await commandLocalStat(lockDirectory);
    if (!lockStat?.isDirectory()) throw new Error("lock-directory-changed");
    metadata.set(lockDirectory, lockStat);
    await withFileLock(path.join(lockDirectory, "publication"), async () => {
      const current = await inspectCommandCreation(root, value.input, options, signal);
      if (current.status !== "proposal" || !sameCommandProposal(value, current.value)) throw new Error("stale-proposal");
      await ensureDirectory(path.dirname(destination));
      const helpers = value.files.filter((file) => file.path !== value.proposal.commandPath);
      if (helpers.length) {
        const helperDirectory = path.dirname(containedPath(root, helpers[0]!.path));
        await ensureDirectory(helperDirectory, true); ignored.add(helperDirectory);
      }
      for (const helper of helpers) {
        const absolute = containedPath(root, helper.path);
        await options.onStage?.("before-helper", absolute);
        await stage(absolute, helper.content);
        await options.onStage?.("after-helper", absolute);
      }
      await stage(temporary, value.files.find((file) => file.path === value.proposal.commandPath)!.content);
      await options.onStage?.("before-publication", destination);
      await checkOwned();
      const final = await inspectCommandCreation(root, value.input, options, signal, ignored);
      if (final.status !== "proposal" || !sameCommandProposal(value, final.value)) throw new Error("stale-publication");
      await checkOwned();
      signal.throwIfAborted();
      // Hard-linking a complete sibling is atomic and fails if another writer won.
      await fs.link(temporary, destination);
      created = true;
      await notify(destination);
      await options.onStage?.("after-publication", destination);
      const resolved = (await discoverCommands(root, options)).resolve(value.proposal.snapshot.command.name);
      loads = !!resolved?.custom && path.resolve(resolved.custom.filePath) === destination &&
        sha256(resolved.custom.prompt) === value.proposal.snapshot.bodySha256;
    });
  } catch {
    warnings.push(created ? "post-commit-check-failed-files-preserved" : "stale-conflicting-unsafe-or-publication-unavailable");
  } finally { await cleanup(); }
  return result();
}

export function sameCommandProposal(left: InspectedCommandProposal, right: InspectedCommandProposal): boolean {
  return stableJson([left.root, left.rootIdentity, left.files, left.proposal.snapshot, left.input, left.inventorySha256, left.prerequisiteSha256]) ===
    stableJson([right.root, right.rootIdentity, right.files, right.proposal.snapshot, right.input, right.inventorySha256, right.prerequisiteSha256]);
}

/** Session-owned permission. No serialized decision/approval flag is accepted. */
export class CommandCreationReview {
  private pending?: InspectedCommandProposal;
  private generation = 0;
  private active = new AbortController();
  private disposed = false;
  constructor(private readonly cwd: string, private readonly options: CommandInspectionOptions & {
    reviewCreation?: CommandCreationReviewer;
    planModeRef?: { current: boolean };
  }) {}

  cancel(): void {
    this.pending = undefined;
    this.generation++;
    this.active.abort();
    this.active = new AbortController();
  }
  dispose(): void { this.cancel(); this.disposed = true; }

  async inspect(input: unknown, signal: AbortSignal) {
    this.cancel();
    const generation = this.generation;
    if (this.disposed || signal.aborted) return { status: "unavailable", reason: "cancelled" } as const;
    const combined = AbortSignal.any([signal, this.active.signal]);
    const result = await inspectCommandCreation(this.cwd, input, this.options, combined);
    if (generation !== this.generation || combined.aborted) return { status: "unavailable", reason: "superseded" } as const;
    if (result.status !== "proposal") return result;
    this.pending = structuredClone(result.value);
    // Retained proposals belong to the session's cancel/dispose lifecycle,
    // not this completed inspection's operation deadline.
    return { status: "proposal", handle: result.value.proposal.proposalId, preview: result.value.preview,
      creationAvailable: !!this.options.reviewCreation && !this.options.planModeRef?.current } as const;
  }

  /** Host-only completion evidence; handles and complete previews remain owned here. */
  inspectionEvidence(text: string): (() => boolean) | undefined {
    const pending = this.pending;
    if (!pending || this.disposed) return;
    try {
      const result = JSON.parse(text);
      if (result?.status === "proposal" && result.handle === pending.proposal.proposalId && result.preview === pending.preview)
        return () => !this.disposed && this.pending === pending;
    } catch { /* Invalid output cannot establish completion. */ }
  }

  /** Host-only continuation; an approved proposal is never returned as a tool result. */
  async consume<T>(handle: string, signal: AbortSignal, publish: (proposal: InspectedCommandProposal, signal: AbortSignal) => Promise<T>): Promise<T | { status: "unavailable"; reason: string }> {
    const pending = this.pending;
    // Consume before any await: concurrent or replayed calls cannot share an answer.
    this.pending = undefined;
    const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
    if (this.disposed || !pending || pending.proposal.proposalId !== handle) return unavailable("unknown-or-consumed-proposal");
    if (!this.options.reviewCreation || this.options.localFilesystem === false) return unavailable("creation-review-unavailable");
    if (this.options.planModeRef?.current) return unavailable("plan-mode");
    const combined = AbortSignal.any([signal, this.active.signal]);
    const questionId = randomUUID();
    const accept = `create:${sha256(pending.preview)}:${randomUUID()}`;
    const fresh = async () => {
      const result = await inspectCommandCreation(this.cwd, pending.input, this.options, combined);
      return result.status === "proposal" && sameCommandProposal(pending, result.value);
    };
    try {
      combined.throwIfAborted();
      if (!await fresh()) return unavailable("stale-proposal-review-again");
      const answer = await this.options.reviewCreation({ questions: [{ id: questionId, kind: "choice", allowOther: false,
        question: "Create exactly these reviewed project command files? Creation does not run them or grant tools.",
        detail: pending.preview, options: [{ label: "Create reviewed files", value: accept },
          { label: "Do not create files", value: "reject", recommended: true }] }] }, combined);
      combined.throwIfAborted();
      if (answer.action !== "answer" || answer.answers[questionId] !== accept) return unavailable("creation-not-approved");
      if (this.options.planModeRef?.current || !await fresh()) return unavailable("stale-proposal-review-again");
      combined.throwIfAborted();
      return await publish(pending, combined);
    } catch {
      return unavailable(combined.aborted ? "cancelled" : "creation-review-failed");
    }
  }
}
