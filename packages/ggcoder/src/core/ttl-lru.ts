/**
 * A bounded least-recently-used cache whose entries also expire.
 *
 * `get` returns nothing for a missing entry or one stored `ttlMs` or more ago
 * (the expired entry is dropped); the oldest-used entry goes first once the
 * cap is passed. The caller passes the clock, so tests need no sleeps.
 */
export class TtlLru<V> {
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { value: V; at: number }>();

  constructor(maxEntries: number, ttlMs: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!(ttlMs > 0)) throw new RangeError(`ttlMs must be positive, got ${ttlMs}`);
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string, now: number): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (now - entry.at >= this.#ttlMs) return undefined;
    // Re-insert so iteration order tracks recency (Map keeps insertion order).
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, at: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, at });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Remove `key` only while it still holds `value` (a newer value is left alone). */
  deleteIf(key: string, value: V): void {
    if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Stored entries, oldest-used first (expired ones included until read). */
  entries(): Array<[string, V]> {
    return [...this.#entries].map(([key, entry]) => [key, entry.value]);
  }
}
