/**
 * Encode a project cwd into a filesystem-safe session-directory name.
 *
 * This is the single source of truth for the cwd → folder-name mapping used by
 * session persistence (`SessionManager`, legacy `session.ts`) and project
 * discovery. Previously three copies drifted; the bug was repeated three times.
 *
 * ## Windows extended-length paths
 *
 * Windows canonicalizes working directories to extended-length form:
 * `\\?\C:\Users\brams`. The `\\?\` prefix — and the `?` it introduces — are
 * illegal in Windows folder names, so `mkdir` throws ENOENT and the sidecar
 * dies on startup. We strip the prefix first so the encoded name is:
 *
 *   1. free of illegal characters, and
 *   2. identical to what the plain (non-canonicalized) path produces.
 *
 * The UNC variant `\\?\UNC\server\share` is normalized to `\\server\share`
 * so it matches a plain UNC path too.
 *
 * The encoding is intentionally one-way; display-time decoding
 * (e.g. `serve-mode`) is best-effort.
 */
export function encodeCwd(cwd: string): string {
  return (
    cwd
      // Normalize Windows extended-length prefixes so canonicalized and plain
      // forms of the same path produce the same folder name.
      //   \\?\UNC\server\share  →  \\server\share
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      //   \\?\C:\…  →  C:\…
      .replace(/^\\\\\?\\/i, "")
      // Path separators → underscore
      .replace(/[\\/]/g, "_")
      // Strip every Windows-reserved character (<>:"|?*) — also covers the
      // drive-letter colon on `C:\`.
      .replace(/[<>:"|?*]/g, "")
      // Drop a leading underscore left by a Unix root slash
      .replace(/^_/, "")
  );
}
