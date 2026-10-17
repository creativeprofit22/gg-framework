/** The version of a file a remembered value was read from. */
export interface FileStamp {
  /** Absolute path the value was read from. */
  readonly path: string;
  readonly size: number;
  /** `stat.mtimeMs`. */
  readonly mtime: number;
}

/**
 * A bounded least-recently-used memo of per-file read results.
 *
 * A value is returned only while its file still has the size and mtime it had
 * when read, so a changed file is always read again. GG Coder transcripts are
 * append-only: every new record changes both. The size cap keeps entries for
 * deleted or rotated files from accumulating; the oldest-used entry goes first.
 *
 * Holds no global state: whoever creates one owns it (the app daemon keeps one
 * for its lifetime so picker refreshes stop re-reading unchanged files).
 */
export class StampedLru<V> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, { size: number; mtime: number; value: V }>();

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The value read from exactly this file version; `undefined` when unknown or changed. */
  lookup(file: FileStamp): { value: V } | undefined {
    const entry = this.#entries.get(file.path);
    if (!entry) return undefined;
    this.#entries.delete(file.path);
    if (entry.size !== file.size || entry.mtime !== file.mtime) return undefined;
    // Re-insert so iteration order tracks recency (Map keeps insertion order).
    this.#entries.set(file.path, entry);
    return { value: entry.value };
  }

  remember(file: FileStamp, value: V): void {
    this.#entries.delete(file.path);
    this.#entries.set(file.path, { size: file.size, mtime: file.mtime, value });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}
