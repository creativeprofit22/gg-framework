import { lstat, open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONTENT_DIGEST_SENTINEL,
  GENERATED_PATHS,
  TAURI_PACKAGE_MARKER,
  canonicalRepositoryRoot,
  containedPath,
  normalizedContentSha256,
  rejectLinks,
  sha256,
} from "./paths.js";
import { TEMPLATE_VERSION, type GeneratedFile, type SupportSetInspection } from "./types.js";

const MARKER_PATTERN = new RegExp(
  `${TAURI_PACKAGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+template_version=(\\d+)\\s+template_sha256=([a-f0-9]{64})\\s+content_sha256=([a-f0-9]{64})`,
);

interface OwnedMarker {
  templateVersion: number;
  templateSha256: string;
  contentSha256: string;
}

export interface CommitOptions {
  revalidate?: () => Promise<void>;
  onPreMutation?: (repositoryPath: string) => Promise<void> | void;
  onCommitted?: (repositoryPath: string) => Promise<void> | void;
  afterWrite?: (repositoryPath: string, index: number) => Promise<void> | void;
}

export function generatedMarker(templateSha256: string, contentSha256: string): string {
  return `${TAURI_PACKAGE_MARKER} template_version=${TEMPLATE_VERSION} template_sha256=${templateSha256} content_sha256=${contentSha256}`;
}

export function finalizeGeneratedContent(contentWithSentinel: string): {
  bytes: Buffer;
  contentSha256: string;
} {
  const occurrences = contentWithSentinel.split(CONTENT_DIGEST_SENTINEL).length - 1;
  if (occurrences !== 1) throw new Error("Generated content must contain one digest sentinel");
  const contentSha256 = normalizedContentSha256(contentWithSentinel);
  return {
    bytes: Buffer.from(contentWithSentinel.replace(CONTENT_DIGEST_SENTINEL, contentSha256), "utf8"),
    contentSha256,
  };
}

export function parseGeneratedMarker(content: string): OwnedMarker | null {
  const match = MARKER_PATTERN.exec(content);
  if (!match) return null;
  return {
    templateVersion: Number(match[1]),
    templateSha256: match[2]!,
    contentSha256: match[3]!,
  };
}

export async function inspectSupportSet(
  repositoryRoot: string,
  expected?: readonly GeneratedFile[],
): Promise<SupportSetInspection> {
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const present: Array<{ path: string; bytes: Buffer }> = [];
  const conflicts: string[] = [];
  for (const repositoryPath of GENERATED_PATHS) {
    const absolute = containedPath(root, repositoryPath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        conflicts.push(`${repositoryPath}: not a regular file`);
        continue;
      }
      await rejectLinks(root, repositoryPath);
      present.push({ path: repositoryPath, bytes: await readFile(absolute) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        conflicts.push(`${repositoryPath}: ${errorMessage(error)}`);
      }
    }
  }
  if (present.length === 0 && conflicts.length === 0) return { state: "absent", conflicts: [], files: [] };
  if (present.length !== GENERATED_PATHS.length || conflicts.length) {
    const presentPaths = new Set(present.map((file) => file.path));
    for (const repositoryPath of GENERATED_PATHS) {
      if (!presentPaths.has(repositoryPath) && !conflicts.some((entry) => entry.startsWith(`${repositoryPath}:`))) {
        conflicts.push(`${repositoryPath}: missing from partial support set`);
      }
    }
    return { state: "conflict", conflicts: conflicts.sort(), files: [] };
  }

  const expectedByPath = new Map(expected?.map((file) => [file.path, file]));
  const files: GeneratedFile[] = [];
  for (const current of present) {
    const content = current.bytes.toString("utf8");
    const marker = parseGeneratedMarker(content);
    if (!marker) {
      conflicts.push(`${current.path}: unknown or legacy generated marker`);
      continue;
    }
    if (marker.templateVersion !== TEMPLATE_VERSION) {
      conflicts.push(`${current.path}: template version ${marker.templateVersion} is not current`);
      continue;
    }
    let calculated: string;
    try {
      calculated = normalizedContentSha256(content);
    } catch (error) {
      conflicts.push(`${current.path}: ${errorMessage(error)}`);
      continue;
    }
    if (calculated !== marker.contentSha256) {
      conflicts.push(`${current.path}: content digest mismatch`);
      continue;
    }
    const wanted = expectedByPath.get(current.path);
    if (wanted && current.path !== GENERATED_PATHS[4] && !current.bytes.equals(wanted.bytes)) {
      conflicts.push(`${current.path}: owned file differs from the deterministic template`);
      continue;
    }
    if (wanted && marker.templateSha256 !== wanted.template_sha256) {
      conflicts.push(`${current.path}: template digest mismatch`);
      continue;
    }
    files.push({
      path: current.path,
      bytes: current.bytes,
      template_sha256: marker.templateSha256,
      content_sha256: marker.contentSha256,
    });
  }
  return conflicts.length
    ? { state: "conflict", conflicts: conflicts.sort(), files: [] }
    : { state: "owned", conflicts: [], files };
}

export async function commitSupportSet(
  repositoryRoot: string,
  rendered: readonly GeneratedFile[],
  options: CommitOptions = {},
): Promise<{ changed: boolean; paths: string[] }> {
  assertCompleteRender(rendered);
  const root = await canonicalRepositoryRoot(repositoryRoot);
  return withRepositoryLock(root, async () => {
    const inspection = await inspectSupportSet(root, rendered);
    if (inspection.state === "conflict") {
      throw new Error(`Refusing to overwrite Tauri support files:\n${inspection.conflicts.join("\n")}`);
    }
    if (
      inspection.state === "owned" &&
      rendered.every((file) => inspection.files.find((current) => current.path === file.path)?.bytes.equals(file.bytes))
    ) {
      return { changed: false, paths: [] };
    }
    const snapshots = new Map<string, Buffer | null>();
    for (const repositoryPath of GENERATED_PATHS) {
      snapshots.set(repositoryPath, await readOptional(containedPath(root, repositoryPath)));
    }
    await options.revalidate?.();
    const written: string[] = [];
    try {
      for (const [index, file] of rendered.entries()) {
        const current = await readOptional(containedPath(root, file.path));
        const snapshot = snapshots.get(file.path) ?? null;
        if (!sameBytes(current, snapshot)) throw new Error(`Concurrent mutation detected: ${file.path}`);
        await options.onPreMutation?.(file.path);
        await atomicWrite(root, file.path, file.bytes);
        written.push(file.path);
        await options.afterWrite?.(file.path, index);
      }
    } catch (error) {
      const rollbackErrors = await rollback(root, rendered, snapshots, written);
      const suffix = rollbackErrors.length ? `\nRollback conflicts:\n${rollbackErrors.join("\n")}` : "";
      throw new Error(`${errorMessage(error)}${suffix}`, { cause: error });
    }
    for (const repositoryPath of written) await options.onCommitted?.(repositoryPath);
    return { changed: true, paths: written };
  });
}

function assertCompleteRender(rendered: readonly GeneratedFile[]): void {
  const paths = rendered.map((file) => file.path);
  if (paths.length !== GENERATED_PATHS.length || GENERATED_PATHS.some((item) => !paths.includes(item))) {
    throw new Error("Renderer must provide the exact six-file Tauri support set");
  }
  if (new Set(paths).size !== paths.length) throw new Error("Renderer returned duplicate support paths");
}

async function rollback(
  root: string,
  rendered: readonly GeneratedFile[],
  snapshots: Map<string, Buffer | null>,
  written: string[],
): Promise<string[]> {
  const errors: string[] = [];
  const renderedByPath = new Map(rendered.map((file) => [file.path, file.bytes]));
  for (const repositoryPath of [...written].reverse()) {
    try {
      const absolute = containedPath(root, repositoryPath);
      const current = await readOptional(absolute);
      if (!sameBytes(current, renderedByPath.get(repositoryPath) ?? null)) {
        errors.push(`${repositoryPath}: changed concurrently; left untouched`);
        continue;
      }
      const snapshot = snapshots.get(repositoryPath) ?? null;
      if (snapshot === null) await rm(absolute, { force: true });
      else await atomicWrite(root, repositoryPath, snapshot);
    } catch (error) {
      errors.push(`${repositoryPath}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function atomicWrite(root: string, repositoryPath: string, bytes: Buffer): Promise<void> {
  const absolute = containedPath(root, repositoryPath);
  await ensureSafeParent(root, repositoryPath);
  const temporary = `${absolute}.gg-tauri-${process.pid}-${sha256(`${repositoryPath}:${Math.random()}`).slice(0, 12)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withRepositoryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(os.tmpdir(), `gg-tauri-package-${sha256(root.toLocaleLowerCase("en-US"))}.lock`);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another Tauri packaging action is active for this repository", { cause: error });
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function readOptional(absolute: string): Promise<Buffer | null> {
  try {
    return await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeParent(root: string, repositoryPath: string): Promise<void> {
  const segments = repositoryPath.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await stat(current);
      const linkInfo = await lstat(current);
      if (linkInfo.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe generated-file parent: ${repositoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const linkInfo = await lstat(current);
      if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
        throw new Error(`Unsafe generated-file parent: ${repositoryPath}`, { cause: error });
      }
    }
  }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
