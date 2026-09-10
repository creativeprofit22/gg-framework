import { statSync } from "node:fs";
import path from "node:path";

/** Native release builds clear both flags. This changes auth only, never session roots. */
export function nativeDevAuthFile(defaultFile: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GG_APP_NATIVE_DEBUG_AUTH_ALLOWED !== "1" || !env.GG_APP_DEV_AUTH_FILE) return defaultFile;
  const file = env.GG_APP_DEV_AUTH_FILE;
  if (!path.isAbsolute(file) || !statSync(file).isFile()) {
    throw new Error("GG_APP_DEV_AUTH_FILE must name an existing absolute file");
  }
  return path.normalize(file);
}
