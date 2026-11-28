import { readFile } from "node:fs/promises";
import { z } from "zod";
import { packageWorkspacePatterns, parsePnpmWorkspace } from "../tauri-package/discover.js";
import { canonicalRepositoryRoot, compareText, sha256 } from "../tauri-package/paths.js";
import {
  buildProgrammaticAreaMap,
  type AreaHistoryInput,
  type AreaManifestFacts,
  type AreaWorkflowFacts,
  type ProgrammaticAreaMapV1,
} from "./area-map.js";
import {
  buildProgrammaticInventory,
  InventoryLimitError,
  validateProgrammaticFile,
} from "./inventory.js";
import { detectProgrammaticItemFamilies } from "./item-families.js";

export const AREA_MAP_COLLECT_LIMITS = Object.freeze({
  maxPackageJsonFiles: 64,
  maxWorkflowFiles: 24,
  maxManifestBytes: 256 * 1024,
  maxHistoryChars: 64 * 1024,
});

export type AreaMapCollectResult =
  | {
      status: "ok";
      areaMap: ProgrammaticAreaMapV1;
      omitted: { changedManifests: number; unparsedManifests: number; overLimit: number };
    }
  | { status: "unavailable"; reason: "inventory-limit" | "unreadable" };

/** Returns git_history change_frequency JSON text; anything else becomes `unavailable`. */
export type AreaHistoryProvider = (signal: AbortSignal | undefined) => Promise<string>;

const historyOkSchema = z.object({
  status: z.literal("ok"),
  action: z.literal("change_frequency"),
  groupBy: z.literal("folder"),
  depth: z.number().int().min(1).max(6),
  window: z.object({ sinceDays: z.number().int().positive() }),
  commitsRead: z.number().int().nonnegative(),
  entries: z
    .array(z.object({ path: z.string().min(1).max(1024), commits: z.number().int().nonnegative() }))
    .max(500),
  truncated: z.object({ commits: z.boolean(), entries: z.boolean(), output: z.boolean() }),
});
const historyUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.string().regex(/^[a-z-]{1,40}$/),
});

export function parseAreaHistory(text: string): AreaHistoryInput {
  if (text.length > AREA_MAP_COLLECT_LIMITS.maxHistoryChars)
    return { status: "unavailable", reason: "output-too-large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "unavailable", reason: "unparsed" };
  }
  const ok = historyOkSchema.safeParse(value);
  if (ok.success) {
    const data = ok.data;
    return {
      status: "ok",
      sinceDays: data.window.sinceDays,
      depth: data.depth,
      commitsRead: data.commitsRead,
      truncated: data.truncated.commits || data.truncated.entries || data.truncated.output,
      entries: data.entries.map((entry) => ({ path: entry.path, commits: entry.commits })),
    };
  }
  const unavailable = historyUnavailableSchema.safeParse(value);
  return unavailable.success
    ? { status: "unavailable", reason: unavailable.data.reason }
    : { status: "unavailable", reason: "unparsed" };
}

/** Two-space keys directly under a top-level `jobs:` block; CRLF-safe, no YAML library. */
export function parseWorkflowJobIds(source: string): string[] {
  const ids = new Set<string>();
  let inJobs = false;
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      continue;
    }
    if (!inJobs) continue;
    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*:/.exec(line);
    const id = match?.[1] ?? match?.[2] ?? match?.[3];
    if (id) ids.add(id);
  }
  return [...ids].sort(compareText);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(objectRecord(value))) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

export function packageJsonFacts(repositoryPath: string, source: string): AreaManifestFacts {
  const json = objectRecord(JSON.parse(source));
  const scripts = stringRecord(json.scripts);
  const dependencyNames = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of Object.keys(objectRecord(json[field]))) dependencyNames.add(name);
  }
  const scriptNames = Object.keys(scripts).sort(compareText);
  return {
    path: repositoryPath,
    ...(typeof json.name === "string" ? { packageName: json.name } : {}),
    scriptNames,
    dependencyNames: [...dependencyNames].sort(compareText),
    scriptText: scriptNames.map((name) => scripts[name]).join("\n"),
    workspacePatterns: repositoryPath.includes("/") ? [] : packageWorkspacePatterns(json),
  };
}

/**
 * Read-only: one strict inventory walk plus hash-verified reads of a bounded set of setup files.
 * Writes nothing; the inventory fingerprint is never stored or compared.
 */
export async function collectProgrammaticAreaMap(
  repositoryRoot: string,
  options: { signal?: AbortSignal; history?: AreaHistoryProvider } = {},
): Promise<AreaMapCollectResult> {
  const { signal } = options;
  let inventory;
  let root: string;
  try {
    root = await canonicalRepositoryRoot(repositoryRoot);
    inventory = (await buildProgrammaticInventory(root, { signal })).inventory;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return {
      status: "unavailable",
      reason: error instanceof InventoryLimitError ? "inventory-limit" : "unreadable",
    };
  }

  const omitted = { changedManifests: 0, unparsedManifests: 0, overLimit: 0 };
  const hashed = inventory.entries.flatMap((entry) =>
    "sha256" in entry ? [{ path: entry.path, sha256: entry.sha256 }] : [],
  );
  const packageJsons = hashed.filter(
    (entry) => entry.path === "package.json" || entry.path.endsWith("/package.json"),
  );
  const workflowFiles = hashed.filter((entry) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path),
  );
  omitted.overLimit +=
    Math.max(0, packageJsons.length - AREA_MAP_COLLECT_LIMITS.maxPackageJsonFiles) +
    Math.max(0, workflowFiles.length - AREA_MAP_COLLECT_LIMITS.maxWorkflowFiles);

  const read = async (entry: { path: string; sha256: string }): Promise<string | null> => {
    signal?.throwIfAborted();
    try {
      const absolute = await validateProgrammaticFile(
        root,
        entry.path,
        undefined,
        AREA_MAP_COLLECT_LIMITS.maxManifestBytes,
      );
      const bytes = await readFile(absolute, { signal });
      if (sha256(bytes) !== entry.sha256) {
        omitted.changedManifests += 1;
        return null;
      }
      return bytes.toString("utf8");
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      omitted.changedManifests += 1;
      return null;
    }
  };

  const manifests: AreaManifestFacts[] = [];
  const pnpm = hashed.find((entry) => entry.path === "pnpm-workspace.yaml");
  if (pnpm) {
    const text = await read(pnpm);
    if (text !== null) {
      try {
        manifests.push({
          path: pnpm.path,
          scriptNames: [],
          dependencyNames: [],
          scriptText: "",
          workspacePatterns: parsePnpmWorkspace(text),
        });
      } catch {
        omitted.unparsedManifests += 1;
      }
    }
  }
  // Shallow manifests first so the root and workspace members survive the cap.
  const orderedPackageJsons = [...packageJsons]
    .sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length ||
        compareText(left.path, right.path),
    )
    .slice(0, AREA_MAP_COLLECT_LIMITS.maxPackageJsonFiles);
  for (const entry of orderedPackageJsons) {
    const text = await read(entry);
    if (text === null) continue;
    try {
      manifests.push(packageJsonFacts(entry.path, text));
    } catch {
      omitted.unparsedManifests += 1;
    }
  }
  const workflows: AreaWorkflowFacts[] = [];
  for (const entry of workflowFiles.slice(0, AREA_MAP_COLLECT_LIMITS.maxWorkflowFiles)) {
    const text = await read(entry);
    if (text !== null) workflows.push({ path: entry.path, jobIds: parseWorkflowJobIds(text) });
  }

  let history: AreaHistoryInput = { status: "unavailable", reason: "not-requested" };
  if (options.history) {
    try {
      history = parseAreaHistory(await options.history(signal));
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      history = { status: "unavailable", reason: "failed" };
    }
  }

  const areaMap = buildProgrammaticAreaMap({
    inventory,
    manifests,
    workflows,
    itemFamilies: detectProgrammaticItemFamilies(inventory),
    history,
  });
  return { status: "ok", areaMap, omitted };
}
