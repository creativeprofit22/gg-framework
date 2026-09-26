import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectGlobalUpdateManager } from "./auto-update-install.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./package-manager-launcher.js", () => ({
  resolvePackageManagerLaunch: (command: string, args: string[]) => ({ command, args }),
}));
const pkg = "@kenkaiiii/ggcoder";

beforeEach(() => {
  vi.spyOn(fs, "realpathSync").mockImplementation((file) => String(file));
  vi.mocked(execFileSync).mockReset().mockImplementation(() => { throw new Error("not installed"); });
});
afterEach(() => vi.restoreAllMocks());

function entry(script: string, platform: NodeJS.Platform = "linux") {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", script]);
}
function globalRoot(manager: string, root: string) {
  vi.mocked(execFileSync).mockImplementation((command) => {
    if (command !== manager) throw new Error("not installed");
    return root;
  });
}

describe("positive global installation ownership", () => {
  it.each([
    ["linux", "npm", "/usr/local/lib/node_modules"],
    ["linux", "npm", "/home/me/.nvm/versions/node/v24/lib/node_modules"],
    ["win32", "npm", "E:/npm-global/node_modules"],
    ["win32", "npm", "C:/Users/me/AppData/Roaming/npm/node_modules"],
    ["linux", "pnpm", "/home/me/.local/share/pnpm/global/5/node_modules"],
    ["win32", "pnpm", "E:/pnpm/global/5/node_modules"],
    ["linux", "yarn", "/home/me/.config/yarn/global"],
    ["win32", "yarn", "E:/yarn/global"],
    ["linux", "yarn", "/custom/global-packages"],
  ] as const)("accepts %s %s owned global root %s", (platform, manager, root) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const modules = manager === "yarn" ? paths.join(root, "node_modules") : root;
    entry(paths.join(modules, pkg, "dist/cli.js"), platform);
    globalRoot(manager, root);
    expect(detectGlobalUpdateManager(pkg)).toBe(manager);
    expect(execFileSync).toHaveBeenCalledWith(manager,
      manager === "yarn" ? ["global", "dir"] : ["root", "-g"],
      expect.objectContaining({ shell: false, timeout: 3000 }));
  });

  it.each([
    String.raw`E:\Projects\gg-framework-fork\packages\ggcoder\dist\cli.js`,
    "E:/bundled/sidecar/cli.js",
    "E:/unknown/cli.js",
    "E:/cache/_npx/123/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "E:/node_modules/other-package/cli.js",
    "",
  ])("rejects non-owned entrypoint without any manager command: %s", (script) => {
    entry(script, "win32");
    expect(detectGlobalUpdateManager(pkg)).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    "/checkout/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "/checkout/node_modules/.pnpm/pkg/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "/checkout/.yarn/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "/other-global/lib/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "/usr/lib/node_modules/@kenkaiiii/ggcoder-extra/dist/cli.js",
  ])("rejects a local or different global copy: %s", (script) => {
    entry(script);
    globalRoot("npm", "/usr/lib/node_modules");
    expect(detectGlobalUpdateManager(pkg)).toBeNull();
  });

  it.each(["relative/node_modules", "/root/node_modules\nwarning", ""])("rejects ambiguous root %s", (root) => {
    entry("/usr/lib/node_modules/@kenkaiiii/ggcoder/cli.js");
    globalRoot("npm", root);
    expect(detectGlobalUpdateManager(pkg)).toBeNull();
  });

  it("fails closed when global discovery fails", () => {
    entry("/usr/lib/node_modules/@kenkaiiii/ggcoder/cli.js");
    expect(detectGlobalUpdateManager(pkg)).toBeNull();
  });

  it("accepts pnpm's real global store package", () => {
    const root = "/home/me/pnpm/global/5/node_modules";
    const stored = `${root}/.pnpm/@kenkaiiii+ggcoder@1.0.0/node_modules/${pkg}`;
    entry(`${stored}/dist/cli.js`);
    globalRoot("pnpm", root);
    vi.mocked(fs.realpathSync).mockImplementation((file) => String(file) === `${root}/${pkg}` ? stored : String(file));
    expect(detectGlobalUpdateManager(pkg)).toBe("pnpm");
  });

  it("rejects a globally linked checkout even if it has node_modules in its path", () => {
    const checkout = `/checkout/node_modules/${pkg}`;
    entry(`${checkout}/cli.js`);
    globalRoot("npm", "/usr/lib/node_modules");
    vi.mocked(fs.realpathSync).mockImplementation((file) =>
      String(file) === `/usr/lib/node_modules/${pkg}` ? checkout : String(file));
    expect(detectGlobalUpdateManager(pkg)).toBeNull();
  });

  it("verifies actual filesystem ownership, including a linked checkout", () => {
    vi.restoreAllMocks();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-install-owner-"));
    try {
      const modules = path.join(root, "node_modules");
      const installed = path.join(modules, pkg);
      const cli = path.join(installed, "cli.js");
      fs.mkdirSync(installed, { recursive: true });
      fs.writeFileSync(cli, "// fixture");
      vi.spyOn(process, "argv", "get").mockReturnValue(["node", cli]);
      globalRoot("npm", modules);
      expect(detectGlobalUpdateManager(pkg)).toBe("npm");

      const linked = path.join(root, "linked/node_modules", pkg);
      fs.mkdirSync(path.dirname(linked), { recursive: true });
      fs.symlinkSync(installed, linked, "junction");
      globalRoot("npm", path.join(root, "linked/node_modules"));
      expect(detectGlobalUpdateManager(pkg)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
