import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";

// Input is already a realpath: preserve component case (including case-sensitive
// Windows directories), but unify drive letters, separators and namespace prefixes.
export function normalizePreviewRoot(root, platform = process.platform) {
  if (platform === "win32") {
    root = root.replaceAll("\\", "/");
    root = root.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
    root = root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  }
  const unc = platform === "win32" && root.startsWith("//");
  const normalized = posix.normalize(root).replace(/\/$/, "") || "/";
  return unc ? `/${normalized}` : normalized;
}

// Checkout provenance only, not authentication or a source-content fingerprint.
export function previewCheckoutIdentity(root) {
  const canonical = normalizePreviewRoot(realpathSync.native(root));
  return createHash("sha256").update(canonical).digest("hex");
}
