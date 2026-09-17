import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { Readable } from "node:stream";
import type {
  ConfigurationSnapshot,
  InventoryEntryV1,
  InventoryV1,
  ProgrammaticProfileEnvelopeV2,
  ProgrammaticProfileEnvelopeV3,
} from "./contracts.js";
import {
  configurationSnapshotSchema,
  inventoryV1Schema,
  programmaticProfileEnvelopeV2Schema,
  programmaticProfileEnvelopeV3Schema,
  PROGRAMMATIC_CONFIGURATION_INPUT_LIMIT,
  PROGRAMMATIC_CONTRACT_VERSION,
} from "./contracts.js";
import {
  canonicalRepositoryRoot,
  containedPath,
  normalizeRepositoryPath,
  rejectLinks,
  relativeRepositoryPath,
  sha256,
  stableJson,
} from "../tauri-package/paths.js";
import { loadGitignore } from "../../tools/gitignore.js";

const CONFIG_FINGERPRINT_VERSION = 2;
const SCANNER_PROFILE_SCHEMA_REVISION = 1;
const DEFAULT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;

export const PROGRAMMATIC_PROFILE_PATH = ".gg/programmatic/profile.json";

export const PROGRAMMATIC_INVENTORY_EXCLUSIONS = [
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/node_modules/**",
  "**/bower_components/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.env",
  "**/.env.*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa",
  "**/id_rsa.pub",
  ".gg/programmatic/state.json",
  ".gg/programmatic/state.previous.json",
  ".gg/programmatic/.state.tmp",
  ".gg/programmatic/.state.previous.tmp",
  ".gg/programmatic/profile.json.lock",
  ".gg/programmatic/state.json.lock",
] as const;

// Host-owned history/recovery documents are not source/configuration inputs. Do not
// alter the saved scanner exclusion policy merely to offer an optional history upgrade.
const HISTORY_MANAGED_FILES = [
  ".gg/programmatic/profile.previous.json", ".gg/programmatic/.profile.previous.tmp",
  ".gg/programmatic/recommendations.json", ".gg/programmatic/recommendations.previous.json",
  ".gg/programmatic/.recommendations.tmp", ".gg/programmatic/.recommendations.previous.tmp",
  ".gg/programmatic/recommendations.json.lock",
];

const CONFIG_FILE_NAMES = new Set([
  ".gitignore",
  ".gitmodules",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  "Tauri.toml",
  ".golangci.yml",
  ".golangci.yaml",
  ".rustfmt.toml",
  "biome.json",
  "biome.jsonc",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "Dockerfile",
  "flake.lock",
  "flake.nix",
  "Gemfile",
  "Gemfile.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "gradle.properties",
  "Makefile",
  "mix.exs",
  "mix.lock",
  "package-lock.json",
  "package.json",
  "Pipfile",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "tox.ini",
  "uv.lock",
  "yarn.lock",
]);
const CONFIG_FILE_PATTERN =
  /^(?:compose(?:\.[^.]+)?\.ya?ml|docker-compose(?:\.[^.]+)?\.ya?ml|requirements(?:-[^.]+)?\.txt|(?:js|ts)config(?:\.[^.]+)?\.json|(?:eslint|jest|next|nx|playwright|prettier|rollup|storybook|svelte|tailwind|turbo|vite|vitest|webpack)\.config\.(?:c|m)?(?:js|ts)|settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|rust-toolchain(?:\.toml)?)$/;
const DOT_CONFIG_PATTERN = /^\.(?:eslint|prettier)rc(?:\.(?:c|m)?(?:js|json|ya?ml))?$/;

export interface InventoryLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface InventorySummaryV1 {
  version: typeof PROGRAMMATIC_CONTRACT_VERSION;
  fileCount: number;
  totalBytes: number;
  configurationFileCount: number;
}

export interface ProgrammaticInventoryResult {
  inventory: InventoryV1;
  summary: InventorySummaryV1;
  configurationInputs: InventoryEntryV1[];
  configurationSnapshot: ConfigurationSnapshot;
}

export interface InventoryOperations {
  lstat(filePath: string): Promise<Stats>;
  readFile(filePath: string): Promise<Buffer>;
  realpath(filePath: string): Promise<string>;
}

interface GlobEntry {
  path: string;
  dirent: {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
}

const localOperations: InventoryOperations = { lstat, readFile, realpath };

export function normalizeInventoryPath(
  entryPath: string,
  separator: "/" | "\\" = path.sep as "/" | "\\",
): string {
  return normalizeRepositoryPath(separator === "\\" ? entryPath.replaceAll("\\", "/") : entryPath);
}

function validatedLimits(overrides: Partial<InventoryLimits> | undefined): InventoryLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer`);
  }
  if (limits.maxFiles > DEFAULT_LIMITS.maxFiles) {
    throw new Error(`maxFiles cannot exceed ${DEFAULT_LIMITS.maxFiles}`);
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new Error("maxFileBytes cannot exceed maxTotalBytes");
  }
  return limits;
}

function isConfigurationInput(repositoryPath: string): boolean {
  if (repositoryPath.startsWith(".gg/programmatic/")) return true;
  if (repositoryPath.startsWith(".github/workflows/")) return /\.ya?ml$/.test(repositoryPath);
  const name = path.posix.basename(repositoryPath);
  return (
    CONFIG_FILE_NAMES.has(name) ||
    CONFIG_FILE_PATTERN.test(name) ||
    DOT_CONFIG_PATTERN.test(name) ||
    /^(?:tauri(?:\.(?:windows|linux|macos|android|ios))?\.conf\.(?:json|json5|toml)|Tauri\.(?:windows|linux|macos|android|ios)\.toml)$/.test(
      name,
    )
  );
}

function limitError(kind: "file count" | "file size" | "total bytes", limit: number): Error {
  return new Error(`Inventory ${kind} limit exceeded (${limit})`);
}

export async function* walkProgrammaticPaths(
  root: string,
  options: { signal?: AbortSignal; gitignoreLines?: string[] } = {},
): AsyncGenerator<{ path: string; kind: "file" | "unsafe" }> {
  options.signal?.throwIfAborted();
  const fg = await import("fast-glob");
  const ignore = await import("ignore");
  const matcher = ignore.default().add(options.gitignoreLines ?? await loadGitignore(root));
  let stream: Readable | undefined;
  const abort = () => stream?.destroy();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    stream = fg.default.stream("**/*", {
      cwd: root,
      dot: true,
      objectMode: true,
      onlyFiles: false,
      ignore: [...PROGRAMMATIC_INVENTORY_EXCLUSIONS, ...HISTORY_MANAGED_FILES],
      suppressErrors: false,
      followSymbolicLinks: false,
      throwErrorOnBrokenSymbolicLink: true,
      unique: true,
    }) as Readable;
    for await (const value of stream) {
      options.signal?.throwIfAborted();
      const entry = value as GlobEntry;
      const repositoryPath = normalizeInventoryPath(entry.path);
      const ignored =
        repositoryPath !== ".gitignore" &&
        !repositoryPath.startsWith(".gg/programmatic/") &&
        (matcher.ignores(repositoryPath) || matcher.ignores(`${repositoryPath}/`));
      if (ignored) continue;
      if (entry.dirent.isSymbolicLink()) {
        yield { path: repositoryPath, kind: "unsafe" };
      } else if (entry.dirent.isFile()) {
        yield { path: repositoryPath, kind: "file" };
      }
    }
    options.signal?.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error("Inventory walk failed", { cause: error });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    stream?.destroy();
  }
}

async function discoverPaths(root: string, maxFiles: number): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walkProgrammaticPaths(root)) {
    if (entry.kind === "unsafe") throw new Error(`Symbolic links are not supported: ${entry.path}`);
    paths.push(entry.path);
    if (paths.length > maxFiles) throw limitError("file count", maxFiles);
  }
  paths.sort();
  return paths;
}

export async function validateProgrammaticFile(
  root: string,
  repositoryPath: string,
  operations: InventoryOperations = localOperations,
  maxFileBytes = Number.MAX_SAFE_INTEGER,
): Promise<string> {
  let absolutePath: string;
  try {
    absolutePath = containedPath(root, repositoryPath);
    await rejectLinks(root, repositoryPath);
    const stat = await operations.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error("link");
    if (!stat.isFile()) throw new Error("not-file");
    if (stat.size > maxFileBytes) throw limitError("file size", maxFileBytes);
    const canonicalPath = await operations.realpath(absolutePath);
    if (relativeRepositoryPath(root, canonicalPath) !== repositoryPath) throw new Error("escape");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Inventory file size")) throw error;
    throw new Error(`Inventory file is unreadable or unsafe: ${repositoryPath}`, { cause: error });
  }
  return absolutePath;
}

async function readInventoryEntry(
  root: string,
  repositoryPath: string,
  operations: InventoryOperations,
  maxFileBytes: number,
): Promise<{ entry: InventoryEntryV1; bytes: number }> {
  const absolutePath = await validateProgrammaticFile(root, repositoryPath, operations, maxFileBytes);
  let bytes: Buffer;
  try {
    bytes = await operations.readFile(absolutePath);
    await rejectLinks(root, repositoryPath);
  } catch {
    throw new Error(`Inventory file is unreadable or unsafe: ${repositoryPath}`);
  }
  if (bytes.length > maxFileBytes) throw limitError("file size", maxFileBytes);
  return { entry: { path: repositoryPath, sha256: sha256(bytes) }, bytes: bytes.length };
}

export async function buildProgrammaticInventory(
  repositoryRoot: string,
  options: {
    limits?: Partial<InventoryLimits>;
    operations?: Partial<InventoryOperations>;
    managedTemporaryPath?: string;
  } = {},
): Promise<ProgrammaticInventoryResult> {
  const limits = validatedLimits(options.limits);
  const operations = { ...localOperations, ...options.operations };
  const root = await canonicalRepositoryRoot(repositoryRoot);
  for (const file of HISTORY_MANAGED_FILES) {
    try { await operations.lstat(containedPath(root, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await rejectLinks(root, file);
  }
  if (
    options.managedTemporaryPath !== undefined &&
    !/^\.gg\/programmatic\/\.profile-\d+-[a-f0-9-]{36}\.tmp$/.test(options.managedTemporaryPath)
  ) {
    throw new Error("Invalid managed profile temporary path");
  }
  const repositoryPaths = (await discoverPaths(root, limits.maxFiles)).filter(
    (repositoryPath) => repositoryPath !== options.managedTemporaryPath,
  );
  const entries: InventoryEntryV1[] = [];
  let totalBytes = 0;
  for (const repositoryPath of repositoryPaths) {
    const result = await readInventoryEntry(root, repositoryPath, operations, limits.maxFileBytes);
    totalBytes += result.bytes;
    if (totalBytes > limits.maxTotalBytes) throw limitError("total bytes", limits.maxTotalBytes);
    entries.push(result.entry);
  }

  const configurationInputs = entries.filter(
    (entry) => entry.path !== PROGRAMMATIC_PROFILE_PATH && isConfigurationInput(entry.path),
  );
  // Every byte of a recognized setup file is input, including cosmetic manifest edits.
  const configurationSnapshot = configurationSnapshotSchema.parse({
    policyRevision: CONFIG_FINGERPRINT_VERSION,
    scannerProfileSchemaRevision: SCANNER_PROFILE_SCHEMA_REVISION,
    exclusions: [...PROGRAMMATIC_INVENTORY_EXCLUSIONS].sort(),
    inputs: configurationInputs,
  });
  const configurationFingerprint = fingerprintConfigurationSnapshot(configurationSnapshot);
  const inventory = inventoryV1Schema.parse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    configurationFingerprint,
    scanners: [],
    entries,
  });
  return {
    inventory,
    summary: {
      version: PROGRAMMATIC_CONTRACT_VERSION,
      fileCount: entries.length,
      totalBytes,
      configurationFileCount: configurationInputs.length,
    },
    configurationInputs,
    configurationSnapshot,
  };
}

export function fingerprintConfigurationSnapshot(snapshot: ConfigurationSnapshot) {
  return {
    version: PROGRAMMATIC_CONTRACT_VERSION,
    sha256: sha256(stableJson(configurationSnapshotSchema.parse(snapshot))),
  };
}

export function validateProfileConfigurationBaseline(
  value: unknown,
): ProgrammaticProfileEnvelopeV2 | ProgrammaticProfileEnvelopeV3 {
  const envelope = (value as { version?: unknown } | null)?.version === 3
    ? programmaticProfileEnvelopeV3Schema.parse(value) : programmaticProfileEnvelopeV2Schema.parse(value);
  if (
    fingerprintConfigurationSnapshot(envelope.configurationSnapshot).sha256 !==
    envelope.configurationFingerprint.sha256
  ) {
    throw new Error("Stored configuration snapshot does not match its fingerprint");
  }
  return envelope;
}

export interface ConfigurationDrift {
  files: {
    path: string;
    kind: "added" | "removed" | "modified";
    before: string | null;
    after: string | null;
  }[];
  policy: { before: number; after: number } | null;
  schema: { before: number; after: number } | null;
  exclusions: { before: string[]; after: string[] } | null;
}

export function compareConfigurationSnapshots(
  previous: ConfigurationSnapshot,
  current: ConfigurationSnapshot,
): ConfigurationDrift {
  const before = configurationSnapshotSchema.parse(previous);
  const after = configurationSnapshotSchema.parse(current);
  const oldInputs = new Map(before.inputs.map((input) => [input.path, input.sha256]));
  const newInputs = new Map(after.inputs.map((input) => [input.path, input.sha256]));
  const paths = [...new Set([...oldInputs.keys(), ...newInputs.keys()])].sort();
  if (paths.length > PROGRAMMATIC_CONFIGURATION_INPUT_LIMIT * 2) {
    throw new Error("Configuration diff input limit exceeded");
  }
  const files: ConfigurationDrift["files"] = [];
  for (const path of paths) {
    const oldHash = oldInputs.get(path) ?? null;
    const newHash = newInputs.get(path) ?? null;
    if (oldHash === newHash) continue;
    files.push({
      path,
      kind: oldHash === null ? "added" : newHash === null ? "removed" : "modified",
      before: oldHash,
      after: newHash,
    });
  }
  return {
    files,
    policy:
      before.policyRevision === after.policyRevision
        ? null
        : { before: before.policyRevision, after: after.policyRevision },
    schema:
      before.scannerProfileSchemaRevision === after.scannerProfileSchemaRevision
        ? null
        : {
            before: before.scannerProfileSchemaRevision,
            after: after.scannerProfileSchemaRevision,
          },
    exclusions:
      stableJson(before.exclusions) === stableJson(after.exclusions)
        ? null
        : { before: before.exclusions, after: after.exclusions },
  };
}
