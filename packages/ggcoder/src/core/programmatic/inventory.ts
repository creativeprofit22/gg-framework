import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { InventoryEntryV1, InventoryV1 } from "./contracts.js";
import { inventoryV1Schema, PROGRAMMATIC_CONTRACT_VERSION } from "./contracts.js";
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

const CONFIG_FINGERPRINT_VERSION = 1;
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
  ".gg/programmatic/state.json.lock",
] as const;

const CONFIG_FILE_NAMES = new Set([
  ".gitignore",
  ".gitmodules",
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
    CONFIG_FILE_NAMES.has(name) || CONFIG_FILE_PATTERN.test(name) || DOT_CONFIG_PATTERN.test(name)
  );
}

function limitError(kind: "file count" | "file size" | "total bytes", limit: number): Error {
  return new Error(`Inventory ${kind} limit exceeded (${limit})`);
}

async function discoverPaths(root: string, maxFiles: number): Promise<string[]> {
  const fg = await import("fast-glob");
  const ignore = await import("ignore");
  const matcher = ignore.default().add(await loadGitignore(root));
  const paths: string[] = [];
  let stream: AsyncIterable<unknown>;
  try {
    stream = fg.default.stream("**/*", {
      cwd: root,
      dot: true,
      objectMode: true,
      onlyFiles: false,
      ignore: [...PROGRAMMATIC_INVENTORY_EXCLUSIONS],
      suppressErrors: false,
      followSymbolicLinks: false,
      throwErrorOnBrokenSymbolicLink: true,
      unique: true,
    });
    for await (const value of stream) {
      const entry = value as GlobEntry;
      const repositoryPath = normalizeInventoryPath(entry.path);
      const ignored =
        repositoryPath !== ".gitignore" &&
        !repositoryPath.startsWith(".gg/programmatic/") &&
        (matcher.ignores(repositoryPath) || matcher.ignores(`${repositoryPath}/`));
      if (ignored) continue;
      if (entry.dirent.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported: ${repositoryPath}`);
      }
      if (!entry.dirent.isFile()) continue;
      paths.push(repositoryPath);
      if (paths.length > maxFiles) throw limitError("file count", maxFiles);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Symbolic links") || error.message.startsWith("Inventory "))
    ) {
      throw error;
    }
    throw new Error("Inventory walk failed", { cause: error });
  }
  paths.sort();
  return paths;
}

async function readInventoryEntry(
  root: string,
  repositoryPath: string,
  operations: InventoryOperations,
  maxFileBytes: number,
): Promise<{ entry: InventoryEntryV1; bytes: number }> {
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
  const configurationFingerprint = {
    version: PROGRAMMATIC_CONTRACT_VERSION,
    sha256: sha256(
      stableJson({
        version: CONFIG_FINGERPRINT_VERSION,
        exclusions: PROGRAMMATIC_INVENTORY_EXCLUSIONS,
        inputs: configurationInputs,
      }),
    ),
  };
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
  };
}
