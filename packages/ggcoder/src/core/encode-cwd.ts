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
    stripExtendedLengthPrefix(cwd)
      // Path separators → underscore
      .replace(/[\\/]/g, "_")
      // Strip every Windows-reserved character (<>:"|?*) — also covers the
      // drive-letter colon on `C:\`.
      .replace(/[<>:"|?*]/g, "")
      // Drop a leading underscore left by a Unix root slash
      .replace(/^_/, "")
  );
}

/**
 * Normalize a Windows extended-length (`\\?\`) path back to its plain form.
 *
 *   `\\?\C:\Users\dev`        → `C:\Users\dev`
 *   `\\?\UNC\server\share`    → `\\server\share`
 *
 * Rust's `canonicalize()` ALWAYS produces the prefixed form, so it is what the
 * shell historically handed the sidecar and what old session headers still
 * record. Nothing else in the system produces it: discovery, the picker and
 * every UI label use the plain form, and Win32 shell APIs reject the prefix
 * outright. Both the folder-name encoding and the cwd read back out of a
 * session header must normalize it, or the same project shows up twice — once
 * as `C:\proj`, once as `\\?\C:\proj`.
 *
 * No-op for plain and POSIX paths.
 */
export function stripExtendedLengthPrefix(cwd: string): string {
  return cwd.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
}
