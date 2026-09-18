import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNativeManagedAuthProvider, nativeDevAuthFile } from "./app-sidecar-native-auth.js";

it("keeps Qwen and Azure native managed and guards the generic API-key route before writing", () => {
  expect(isNativeManagedAuthProvider("qwen-cloud")).toBe(true);
  expect(isNativeManagedAuthProvider("azure")).toBe(true);
  expect(isNativeManagedAuthProvider("openai")).toBe(false);
  const source = readFileSync(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const route = source.slice(
    source.indexOf('if (method === "POST" && url === "/auth/apikey")'),
    source.indexOf('if (method === "POST" && url === "/auth/oauth/start")'),
  );
  expect(route).toContain('isNativeManagedAuthProvider(provider) || key.startsWith("sk-sp-")');
  expect(route.indexOf("json(res, 400")).toBeLessThan(route.indexOf("await auth.setCredentials"));
});

it("keeps Qwen out of CLI automatic fallback while accepting an explicitly selected provider", () => {
  const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  const resolver = source.slice(
    source.indexOf("async function resolveActiveProvider("),
    source.indexOf("function extractText("),
  );
  const fallbacks = resolver.slice(resolver.indexOf("const allProviders"), resolver.indexOf("];"));
  expect(fallbacks).not.toContain('"qwen-cloud"');
  expect(resolver).toContain('if (preferred === "qwen-cloud")');
  expect(resolver).toContain(
    'throw new Error("Qwen Cloud requires dedicated Token Plan runtime authentication.")',
  );
});

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
