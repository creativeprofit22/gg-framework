// @ts-check
// Result helpers. Expected failures (bad input, refused runs, missing files)
// are returned as values; only programming bugs throw.

/**
 * @template T
 * @typedef {{ ok: true, value: T }} Ok
 */
/**
 * @typedef {{ code: string, message: string, details?: unknown }} BenchError
 * @typedef {{ ok: false, error: BenchError }} Err
 */
/**
 * @template T
 * @typedef {Ok<T> | Err} Result
 */

/**
 * @template T
 * @param {T} value
 * @returns {Ok<T>}
 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {Err}
 */
export function err(code, message, details) {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

/**
 * Run an async function and turn a thrown error into an Err with `code`.
 * Use only at I/O boundaries where the OS can fail (missing file, EACCES).
 * @template T
 * @param {string} code
 * @param {() => Promise<T>} fn
 * @returns {Promise<Result<T>>}
 */
export async function attempt(code, fn) {
  try {
    return ok(await fn());
  } catch (error) {
    return err(code, error instanceof Error ? error.message : String(error));
  }
}
