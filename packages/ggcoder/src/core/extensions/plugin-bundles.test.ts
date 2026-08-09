import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionLoader } from "./loader.js";
import { installPlugin, listInstalledPlugins, packPlugin, removePlugin } from "./plugin-bundles.js";

let root: string;
let source: string;
let extensions: string;
let artifact: string;

async function writePlugin(id = "example.plugin", version = "1.2.3"): Promise<void> {
  await fs.mkdir(path.join(source, "commands"), { recursive: true });
  await fs.writeFile(
    path.join(source, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: "Example Plugin",
      version,
      entry: "index.mjs",
      commands: ["commands/review.md"],
    }),
  );
  await fs.writeFile(
    path.join(source, "index.mjs"),
    "export default () => ({ name: 'example', activate() {} });\n",
  );
  await fs.writeFile(path.join(source, "commands", "review.md"), "Review this change.\n");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-plugin-test-"));
  source = path.join(root, "source");
  extensions = path.join(root, "extensions");
  artifact = path.join(root, "example.ggplugin");
  await writePlugin();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("plugin bundles", () => {
  it("packs, installs, lists, updates, and removes a portable plugin without rewriting its manifest", async () => {
    const originalManifest = await fs.readFile(path.join(source, "plugin.json"), "utf8");
    await packPlugin(source, artifact);
    const installed = await installPlugin(artifact, extensions);

    expect(installed).toMatchObject({ id: "example.plugin", version: "1.2.3" });
    expect(await fs.readFile(path.join(installed.installPath, "plugin.json"), "utf8")).toBe(
      originalManifest,
    );
    expect(
      await fs.readFile(path.join(installed.installPath, "commands", "review.md"), "utf8"),
    ).toBe("Review this change.\n");
    expect(await listInstalledPlugins(extensions)).toEqual([installed]);
    const loader = new ExtensionLoader();
    await loader.loadAll(extensions, {} as never);
    expect(loader.getLoaded()).toMatchObject([{ name: "example" }]);

    await fs.rm(source, { recursive: true, force: true });
    await fs.mkdir(source, { recursive: true });
    await writePlugin("example.plugin", "2.0.0");
    await packPlugin(source, artifact);
    await installPlugin(artifact, extensions);
    expect(await listInstalledPlugins(extensions)).toMatchObject([
      { id: "example.plugin", version: "2.0.0" },
    ]);

    await removePlugin("example.plugin", extensions);
    expect(await listInstalledPlugins(extensions)).toEqual([]);
  });

  it("rejects source symlinks and unsupported executable files", async () => {
    await fs.symlink(path.join(source, "index.mjs"), path.join(source, "linked.mjs"));
    await expect(packPlugin(source, artifact)).rejects.toThrow("symlinks");
    await fs.rm(path.join(source, "linked.mjs"));
    await fs.writeFile(path.join(source, "payload.exe"), "bad");
    await expect(packPlugin(source, artifact)).rejects.toThrow("Unsupported plugin file type");
  });

  it("does not let manually placed plugin manifests load entries outside their directory", async () => {
    const pluginDir = path.join(extensions, "malicious");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "malicious",
        name: "Malicious",
        version: "1.0.0",
        entry: "../outside.mjs",
      }),
    );
    await fs.writeFile(
      path.join(extensions, "outside.mjs"),
      "export default () => ({ name: 'escaped', activate() {} });\n",
    );
    const loader = new ExtensionLoader();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loader.loadAll(extensions, {} as never);

    expect(loader.getLoaded()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unsafe plugin path"));
    errorSpy.mockRestore();
  });

  it("rejects traversal and duplicate paths before writing outside the install root", async () => {
    const manifest = {
      schemaVersion: 1,
      id: "example.plugin",
      name: "Example Plugin",
      version: "1.0.0",
      entry: "index.mjs",
    };
    await fs.writeFile(
      artifact,
      JSON.stringify({
        format: "gg-agent-plugin",
        schemaVersion: 1,
        manifest,
        files: [
          {
            path: "plugin.json",
            contentBase64: Buffer.from(JSON.stringify(manifest)).toString("base64"),
          },
          {
            path: "index.mjs",
            contentBase64: Buffer.from("export default () => ({})").toString("base64"),
          },
          { path: "../escaped.js", contentBase64: Buffer.from("bad").toString("base64") },
        ],
      }),
    );

    await expect(installPlugin(artifact, extensions)).rejects.toThrow("Unsafe plugin path");
    await expect(fs.stat(path.join(root, "escaped.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
