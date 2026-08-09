import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LSP_SERVER_CATALOG } from "./servers.js";

/**
 * A root that genuinely has its own `typescript` installed. pnpm does not hoist
 * `typescript` to the workspace root, so the repo root would silently exercise
 * the bundled fallback instead of the branch this file means to cover.
 */
const OWN_TS_ROOT = path.resolve(import.meta.dirname, "../../..");

const tsSpec = LSP_SERVER_CATALOG.find((spec) => spec.id === "typescript");

/** Narrow `initializationOptions: unknown` to the shape tsserver reads. */
interface TsInitializationOptions {
  disableAutomaticTypingAcquisition?: boolean;
  maxTsServerMemory?: number;
  tsserver?: { useSyntaxServer?: string; path?: string };
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A project root with no `typescript` of its own — exercises the bundled path. */
async function bareProjectRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-lsp-servers-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
  return dir;
}

describe("typescript server tuning", () => {
  it("is present in the catalog", () => {
    expect(tsSpec).toBeDefined();
  });

  /**
   * Both flags are what collapse four processes per root down to two, so they
   * are asserted on every branch of `resolveCommand`. `useSyntaxServer` is
   * nested under `tsserver`; the other two are top level — that split is the
   * contract typescript-language-server 5.3.0 reads in `initialize`.
   */
  it("disables the syntax server and typing acquisition for a project with its own typescript", () => {
    const resolved = tsSpec?.resolveCommand(OWN_TS_ROOT);
    expect(resolved).not.toBeNull();

    const options = resolved?.initializationOptions as TsInitializationOptions;
    expect(options.tsserver?.useSyntaxServer).toBe("never");
    expect(options.disableAutomaticTypingAcquisition).toBe(true);
    expect(options.maxTsServerMemory).toBe(3072);
  });

  it("keeps the same tuning on the bundled-tsserver fallback path", async () => {
    const resolved = tsSpec?.resolveCommand(await bareProjectRoot());
    expect(resolved).not.toBeNull();

    const options = resolved?.initializationOptions as TsInitializationOptions;
    expect(options.tsserver?.useSyntaxServer).toBe("never");
    expect(options.disableAutomaticTypingAcquisition).toBe(true);
    expect(options.maxTsServerMemory).toBe(3072);
  });

  /**
   * The fallback branch merges into `tsserver`, so an explicit tsserver path
   * must survive alongside `useSyntaxServer` — dropping it breaks diagnostics
   * for every project that has no TypeScript installed.
   */
  it("still pins the bundled tsserver path when the project has no typescript", async () => {
    const resolved = tsSpec?.resolveCommand(await bareProjectRoot());
    const options = resolved?.initializationOptions as TsInitializationOptions;

    expect(options.tsserver?.path).toMatch(/typescript[/\\]lib[/\\]tsserver\.js$/);
  });

  /** The project's own TypeScript must keep winning: no path override there. */
  it("does not override the tsserver path for a project with its own typescript", () => {
    const resolved = tsSpec?.resolveCommand(OWN_TS_ROOT);
    const options = resolved?.initializationOptions as TsInitializationOptions;

    expect(options.tsserver?.path).toBeUndefined();
  });
});
