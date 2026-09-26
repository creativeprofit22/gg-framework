import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolvePackageManagerLaunch } from "./package-manager-launcher.js";

const dir = "C:\\Program Files\\Node & Tools";
const args = ["install", "-g", "@scope/package@latest", "argument with spaces", "literal&value"];

describe("package manager launch resolution", () => {
  it.each([
    ["npm", "node_modules\\npm\\bin\\npm-cli.js"],
    ["pnpm", "node_modules\\pnpm\\bin\\pnpm.cjs"],
    ["yarn", "node_modules\\yarn\\bin\\yarn.js"],
    ["pnpm", "node_modules\\corepack\\dist\\pnpm.js"],
    ["yarn", "node_modules\\corepack\\dist\\yarn.js"],
  ] as const)("runs %s's %s through Node without argument splitting", (manager, relative) => {
    const script = `${dir}\\${relative}`;
    const files = new Set([`${dir}\\${manager}.cmd`, script]);
    expect(resolvePackageManagerLaunch(manager, args, { Path: `"${dir}"` }, "win32", (p) => files.has(p)))
      .toEqual({ command: process.execPath, args: [script, ...args] });
  });

  it.runIf(process.platform === "win32").each([
    ["npm", "node_modules/npm/bin/npm-cli.js"],
    ["pnpm", "node_modules/pnpm/bin/pnpm.cjs"],
    ["yarn", "node_modules/yarn/bin/yarn.js"],
  ] as const)("executes a harmless %s fixture with exact argv on Windows", (manager, relative) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg manager & spaces-"));
    try {
      const cli = path.join(root, relative);
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(path.join(root, `${manager}.cmd`), "@exit /b 1\r\n");
      fs.writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const launch = resolvePackageManagerLaunch(manager, args, { Path: root });
      const result = spawnSync(launch.command, launch.args, { shell: false, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports a standalone pnpm executable", () => {
    const exe = `${dir}\\pnpm.exe`;
    expect(resolvePackageManagerLaunch("pnpm", args, { PATH: dir }, "win32", (p) => p === exe))
      .toEqual({ command: exe, args });
  });

  it("fails closed on an unknown shim rather than using a shell or later installation", () => {
    expect(() => resolvePackageManagerLaunch("npm", args, { PATH: `${dir};C:\\Other` }, "win32",
      (p) => p === `${dir}\\npm.cmd` || p.startsWith("C:\\Other\\"))).toThrow("Unsupported npm launcher");
  });

  it("ignores cwd and relative PATH entries", () => {
    expect(() => resolvePackageManagerLaunch("npm", args, { PATH: ";.;tools" }, "win32", () => true))
      .toThrow("npm launcher not found");
  });

  it("preserves Unix execution and argv", () => {
    expect(resolvePackageManagerLaunch("npm", args, {}, "linux", () => false))
      .toEqual({ command: "npm", args });
  });
});
