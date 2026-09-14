import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeDevAuthFile } from "./app-sidecar-native-auth.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("ignores inherited overrides without native debug opt-in", () => {
  expect(nativeDevAuthFile("isolated/auth.json", { GG_APP_DEV_AUTH_FILE: "relative.json" })).toBe("isolated/auth.json");
  expect(nativeDevAuthFile("isolated/auth.json", { GG_APP_NATIVE_DEBUG_AUTH_ALLOWED: "1" })).toBe("isolated/auth.json");
});

it("shares only the existing file path, leaving default storage roots unchanged", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-auth-path-")); dirs.push(dir);
  const file = path.join(dir, "auth.json"); writeFileSync(file, "{}");
  const defaults = { authFile: "isolated/auth.json", agentDir: "isolated", sessionsDir: "isolated/sessions" };
  expect(nativeDevAuthFile(defaults.authFile, { GG_APP_NATIVE_DEBUG_AUTH_ALLOWED: "1", GG_APP_DEV_AUTH_FILE: file })).toBe(file);
  expect(defaults).toEqual({ authFile: "isolated/auth.json", agentDir: "isolated", sessionsDir: "isolated/sessions" });
});

it("rejects relative paths, missing files and directories", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-auth-path-")); dirs.push(dir);
  for (const file of ["auth.json", path.join(dir, "missing.json"), dir]) {
    expect(() => nativeDevAuthFile("isolated/auth.json", { GG_APP_NATIVE_DEBUG_AUTH_ALLOWED: "1", GG_APP_DEV_AUTH_FILE: file })).toThrow();
  }
});
