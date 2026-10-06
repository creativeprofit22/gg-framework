import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, ExtensionContext, ExtensionFactory } from "./types.js";
import { readPluginManifest, validatePluginPath } from "./plugin-bundles.js";

export class ExtensionLoader {
  private loaded: Extension[] = [];

  async loadAll(extensionsDir: string, context: ExtensionContext): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(extensionsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      let filePath: string | null = null;
      if (entry.isFile() && entry.name.endsWith(".js")) {
        // Backward-compatible flat extension format.
        filePath = path.join(extensionsDir, entry.name);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        try {
          const pluginDir = path.join(extensionsDir, entry.name);
          const manifest = await readPluginManifest(pluginDir);
          if (manifest.id !== entry.name) {
            throw new Error("Plugin id must match its install directory");
          }
          const entryPath = validatePluginPath(manifest.entry);
          filePath = path.join(pluginDir, ...entryPath.split("/"));
        } catch (err) {
          console.error(
            `Failed to validate plugin ${entry.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (!filePath) continue;

      try {
        const mod = await import(pathToFileURL(filePath).href);
        const factory: ExtensionFactory =
          typeof mod.default === "function" ? mod.default : mod.createExtension;

        if (typeof factory !== "function") {
          console.error(`Extension ${entry.name}: no default export or createExtension function`);
          continue;
        }

        const extension = factory();
        await extension.activate(context);
        this.loaded.push(extension);
      } catch (err) {
        console.error(
          `Failed to load extension ${entry.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  getLoaded(): Extension[] {
    return [...this.loaded];
  }

  async deactivateAll(): Promise<void> {
    for (const ext of this.loaded) {
      try {
        await ext.deactivate?.();
      } catch {
        // Ignore deactivation errors
      }
    }
    this.loaded = [];
  }
}
