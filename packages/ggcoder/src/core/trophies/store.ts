// Durable trophies file (~/.gg/trophies.json): read-modify-write under the
// same file lock and atomic rename the progress store uses, so several app
// processes can record at once without losing an unlock.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getAppPaths, withFileLock } from "@kenkaiiii/gg-core";
import { TROPHY_COUNTERS, TROPHY_SETS, type TrophyFile } from "./types.js";

const factsSchema = z.object({
  prompts: z.number(),
  commits: z.number(),
  linesShipped: z.number(),
  level: z.number(),
});

const fileSchema = z.object({
  v: z.literal(2),
  createdAt: z.string(),
  baseline: factsSchema.nullable(),
  streak: z.object({ last: z.string().nullable(), current: z.number(), best: z.number() }),
  counters: z.record(z.string(), z.number()),
  sets: z.record(z.string(), z.array(z.string())),
  unlocked: z.record(z.string(), z.string()),
  lastEvent: z.object({ nonce: z.string(), unlocked: z.array(z.string()) }).nullable(),
});

export function createEmptyTrophies(now = new Date()): TrophyFile {
  return {
    v: 2,
    createdAt: now.toISOString(),
    baseline: null,
    streak: { last: null, current: 0, best: 0 },
    counters: {},
    sets: {},
    unlocked: {},
    lastEvent: null,
  };
}

/** Keep only known counters and sets, so a newer app's keys don't break this one. */
function normalize(parsed: z.infer<typeof fileSchema>): TrophyFile {
  const counters: TrophyFile["counters"] = {};
  for (const key of TROPHY_COUNTERS) {
    const value = parsed.counters[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) counters[key] = value;
  }
  const sets: TrophyFile["sets"] = {};
  for (const key of TROPHY_SETS) {
    const value = parsed.sets[key];
    if (value) sets[key] = [...new Set(value)];
  }
  return { ...parsed, counters, sets };
}

function resolvePath(filePath?: string): string {
  return filePath ?? getAppPaths().trophiesFile;
}

type ReadResult = TrophyFile | "missing" | "obsolete" | "damaged";

async function readFile(filePath: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return "missing";
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "damaged";
  }
  // Version 1 shipped only in pre-release builds and credited past XP as
  // trophies. Everyone starts from zero, so it's dropped, not kept aside.
  if (typeof json === "object" && json !== null && (json as { v?: unknown }).v === 1) {
    return "obsolete";
  }
  const parsed = fileSchema.safeParse(json);
  return parsed.success ? normalize(parsed.data) : "damaged";
}

const isFile = (r: ReadResult): r is TrophyFile => typeof r === "object";

async function atomicWrite(filePath: string, file: TrophyFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

export interface LoadedTrophies {
  file: TrophyFile;
  /** True when no usable file existed (first run, or a damaged file). */
  fresh: boolean;
}

/** Read the file, or start an empty one. Never writes. */
export async function loadTrophies(filePath?: string): Promise<LoadedTrophies> {
  const read = await readFile(resolvePath(filePath));
  return isFile(read) ? { file: read, fresh: false } : { file: createEmptyTrophies(), fresh: true };
}

/**
 * Read-modify-write under the lock. A damaged file is set aside as
 * `trophies.json.bad` rather than silently replaced.
 */
export async function updateTrophies<T>(
  mutate: (file: TrophyFile) => T,
  filePath?: string,
): Promise<{ file: TrophyFile; result: T }> {
  const target = resolvePath(filePath);
  return withFileLock(target, async () => {
    const read = await readFile(target);
    let current: TrophyFile;
    if (isFile(read)) {
      current = read;
    } else {
      if (read === "damaged") await fs.rename(target, `${target}.bad`).catch(() => {});
      current = createEmptyTrophies();
    }
    const result = mutate(current);
    await atomicWrite(target, current);
    return { file: current, result };
  });
}
