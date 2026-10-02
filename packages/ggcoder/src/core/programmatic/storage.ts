import type { Stats } from "node:fs";
import { canonicalJson, containedPath, rejectLinks } from "../tauri-package/paths.js";

/** Private bounded-file primitives. Owners retain locks, policy and reconciliation. */
export interface ProgrammaticStorageOperations {
  lstat(filePath: string): Promise<Stats>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, bytes: Uint8Array, options: { flag: "wx" }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
}
interface DocumentContract<T> { parse(input: unknown): T }
interface MutationOptions {
  signal?: AbortSignal;
  /** Live host ownership check after all async validation, immediately before rename. */
  assertCurrent?: () => void;
  onPreFileMutation?: (repositoryPath: string) => Promise<void> | void;
  onFileMutated?: (repositoryPath: string) => Promise<void> | void;
}
export type StoredCandidate<T> = { status: "missing" | "invalid" } | { status: "valid"; state: T; bytes: Buffer };
export async function readBoundedCandidate<T>(absolutePath: string, operations: ProgrammaticStorageOperations,
  schema: DocumentContract<T>, byteLimit: number): Promise<StoredCandidate<T>> {
  try {
    const stat = await operations.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile() || !Number.isFinite(stat.size) || stat.size < 0 || stat.size > byteLimit)
      return { status: "invalid" };
    const raw = await operations.readFile(absolutePath);
    if (raw.length > byteLimit) return { status: "invalid" };
    const state = schema.parse(JSON.parse(raw.toString("utf8")) as unknown);
    return { status: "valid", state, bytes: Buffer.from(canonicalJson(state), "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "invalid" };
  }
}
/** The destination rename completed; notification or cleanup failed afterward. */
export class ProgrammaticFilePostCommitError extends Error {
  constructor(readonly repositoryPath: string, cause: unknown, message = "Lifecycle state was persisted, but post-commit processing failed.") {
    super(message, { cause });
  }
}
export async function replaceBoundedFile<T>(root: string, repositoryPath: string, temporaryRepositoryPath: string,
  state: T, operations: ProgrammaticStorageOperations, options: MutationOptions,
  schema: DocumentContract<T>, byteLimit: number,
  commit: (rename: () => Promise<void>) => Promise<void>, label = "Lifecycle state", exactBytes?: Buffer): Promise<void> {
  options.signal?.throwIfAborted();
  const destination = containedPath(root, repositoryPath);
  const temporary = containedPath(root, temporaryRepositoryPath);
  const serialized = canonicalJson(state);
  if (Buffer.byteLength(serialized, "utf8") > byteLimit) throw new Error(`${label} exceeds the byte limit`);
  const bytes = exactBytes ? Buffer.from(exactBytes) : Buffer.from(serialized, "utf8");
  if (bytes.length > byteLimit) throw new Error(`${label} exceeds the byte limit`);
  await operations.rm(temporary, { force: true });
  let committed = false;
  const failures: unknown[] = [];
  const validateTemporary = async () => {
    await rejectLinks(root, temporaryRepositoryPath);
    const temporaryStat = await operations.lstat(temporary);
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile() || !Number.isFinite(temporaryStat.size) || temporaryStat.size < 0 || temporaryStat.size > byteLimit)
      throw new Error(`Temporary ${label.toLowerCase()} validation failed`);
    const temporaryBytes = await operations.readFile(temporary);
    if (temporaryBytes.length > byteLimit) throw new Error(`Temporary ${label.toLowerCase()} exceeds the byte limit`);
    const validated = schema.parse(JSON.parse(temporaryBytes.toString("utf8")) as unknown);
    if (!temporaryBytes.equals(bytes) || canonicalJson(validated) !== serialized)
      throw new Error(`Temporary ${label.toLowerCase()} validation failed`);
  };
  try {
    await operations.writeFile(temporary, bytes, { flag: "wx" });
    await validateTemporary();
    await rejectLinks(root, repositoryPath, true);
    options.signal?.throwIfAborted();
    await options.onPreFileMutation?.(repositoryPath);
    options.signal?.throwIfAborted();
    await commit(async () => {
      await validateTemporary();
      await rejectLinks(root, repositoryPath, true);
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      await operations.rename(temporary, destination); committed = true;
    });
    await options.onFileMutated?.(repositoryPath);
  } catch (error) { failures.push(error); }
  try { await operations.rm(temporary, { force: true }); } catch (error) { failures.push(error); }
  if (failures.length) {
    const cause = failures.length === 1 ? failures[0] : new AggregateError(failures, "Lifecycle mutation and temporary cleanup failed.");
    if (committed) throw new ProgrammaticFilePostCommitError(repositoryPath, cause, `${label} was persisted, but post-commit processing failed.`);
    throw cause;
  }
}
