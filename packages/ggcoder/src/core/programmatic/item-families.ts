import type { InventoryV1 } from "./contracts.js";
import { inventoryV1Schema, PROGRAMMATIC_CONTRACT_VERSION } from "./contracts.js";
import { compareText, sha256, stableJson } from "../tauri-package/paths.js";

/**
 * Path-derived item families: groups of structurally similar items found from inventory
 * paths, names and sizes only. Advisory setup evidence; never scanner findings, routes,
 * lifecycle entries, fingerprints or drift inputs. No file contents are read.
 */
export const ITEM_FAMILY_LIMITS = Object.freeze({
  minMembers: 3,
  minShapeFiles: 2,
  minSimilarityPercent: 60,
  maxFamilies: 12,
  maxMembersPerFamily: 12,
  maxShapePaths: 24,
  maxDiffPathsPerMember: 6,
  maxPathChars: 160,
  maxFilesPerMember: 256,
  maxSerializedBytes: 24 * 1024,
});

export interface ItemFamilyDirectoryMemberV1 {
  path: string;
  fileCount: number;
  /** Sum of listed sizes; setup files are listed by hash only and counted in `unsizedFiles`. */
  bytes: number;
  unsizedFiles: number;
  similarityPercent: number;
  missing: string[];
  missingCount: number;
  extra: string[];
  extraCount: number;
}

export type ItemFamilyV1 =
  | {
      id: string;
      kind: "sibling-directories";
      parent: string;
      memberCount: number;
      shape: string[];
      shapeFileCount: number;
      members: ItemFamilyDirectoryMemberV1[];
    }
  | {
      id: string;
      kind: "file-name-pattern";
      parent: string;
      pattern: string;
      memberCount: number;
      members: { path: string; bytes: number | null }[];
    };

export interface ProgrammaticItemFamiliesV1 {
  version: typeof PROGRAMMATIC_CONTRACT_VERSION;
  basis: "observed-paths";
  /** Replaces a member directory's own name (3+ characters, exact case) in its relative paths. */
  nameToken: typeof NAME_TOKEN;
  thresholds: { minMembers: number; minShapeFiles: number; minSimilarityPercent: number };
  limits: Omit<typeof ITEM_FAMILY_LIMITS, "minMembers" | "minShapeFiles" | "minSimilarityPercent">;
  families: ItemFamilyV1[];
  omitted: {
    families: number;
    members: number;
    longPaths: number;
    oversizedMembers: number;
    listTruncations: number;
  };
}

type Omitted = ProgrammaticItemFamiliesV1["omitted"];
interface ObservedFile {
  path: string;
  bytes: number | null;
}
interface Candidate {
  path: string;
  tokens: Set<string>;
  bytes: number;
  unsizedFiles: number;
}
interface RawFamily {
  id: string;
  memberCount: number;
  build: (omitted: Omitted) => ItemFamilyV1;
}

const NAME_TOKEN = "{name}";
const ROOT = ".";
const HOST_PREFIX = ".gg/programmatic/";
const L = ITEM_FAMILY_LIMITS;

function parentOf(repositoryPath: string): string {
  const index = repositoryPath.lastIndexOf("/");
  return index < 0 ? ROOT : repositoryPath.slice(0, index);
}

function familyId(value: Record<string, unknown>): string {
  return sha256(stableJson({ version: PROGRAMMATIC_CONTRACT_VERSION, ...value })).slice(0, 16);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareText);
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

/** Exact integer Jaccard check: |A∩B| / |A∪B| >= minSimilarityPercent. */
function similarEnough(left: Set<string>, right: Set<string>): boolean {
  const shared = intersectionSize(left, right);
  return shared * 100 >= L.minSimilarityPercent * (left.size + right.size - shared);
}

function boundPaths(paths: string[], max: number, omitted: Omitted): string[] {
  const fitting = paths.filter((item) => item.length <= L.maxPathChars);
  omitted.longPaths += paths.length - fitting.length;
  if (fitting.length > max) omitted.listTruncations += 1;
  return fitting.slice(0, max);
}

/** Directory candidates: every directory with a bounded descendant file set. */
function directoryCandidates(paths: ObservedFile[]) {
  const counts = new Map<string, number>();
  for (const { path } of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  const candidates = new Map<string, Candidate>();
  let oversized = 0;
  for (const [directory, count] of counts) {
    if (count > L.maxFilesPerMember) oversized += 1;
    else if (count >= L.minShapeFiles && directory.length <= L.maxPathChars) {
      candidates.set(directory, { path: directory, tokens: new Set(), bytes: 0, unsizedFiles: 0 });
    }
  }
  for (const { path, bytes } of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const candidate = candidates.get(segments.slice(0, depth).join("/"));
      if (!candidate) continue;
      const name = segments[depth - 1] ?? "";
      const relative = segments
        .slice(depth)
        .map((segment) => (name.length >= 3 ? segment.replaceAll(name, NAME_TOKEN) : segment))
        .join("/");
      candidate.tokens.add(relative);
      if (bytes === null) candidate.unsizedFiles += 1;
      else candidate.bytes += bytes;
    }
  }
  return { candidates: [...candidates.values()], oversized };
}

/**
 * Exact prefix-filtered similarity join inside one parent bucket: tokens are ordered by
 * ascending bucket frequency, each set indexes only its first |s| - ceil(t|s|) + 1 tokens,
 * and only pairs sharing an indexed token are verified exactly. Lossless versus brute force.
 */
function similarComponents(bucket: Candidate[]): Candidate[][] {
  const frequency = new Map<string, number>();
  for (const candidate of bucket)
    for (const token of candidate.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const order = (left: string, right: string) =>
    (frequency.get(left) ?? 0) - (frequency.get(right) ?? 0) || compareText(left, right);
  const roots = bucket.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (roots[root] !== root) root = roots[root] ?? root;
    roots[index] = root;
    return root;
  };
  const index = new Map<string, number[]>();
  bucket.forEach((candidate, current) => {
    const tokens = [...candidate.tokens].sort(order);
    const required = Math.floor((tokens.length * L.minSimilarityPercent + 99) / 100);
    const prefix = tokens.slice(0, tokens.length - required + 1);
    const checked = new Set<number>();
    for (const token of prefix) {
      for (const other of index.get(token) ?? []) {
        if (checked.has(other)) continue;
        checked.add(other);
        const earlier = bucket[other];
        if (!earlier || !similarEnough(candidate.tokens, earlier.tokens)) continue;
        const [left, right] = [find(other), find(current)].sort((a, b) => a - b);
        if (left !== undefined && right !== undefined) roots[right] = left;
      }
      const indexed = index.get(token) ?? [];
      indexed.push(current);
      index.set(token, indexed);
    }
  });
  const components = new Map<number, Candidate[]>();
  bucket.forEach((candidate, current) => {
    const root = find(current);
    const members = components.get(root) ?? [];
    members.push(candidate);
    components.set(root, members);
  });
  return [...components.values()].filter((members) => members.length >= L.minMembers);
}

/** Majority shape; members below the threshold are dropped until the shape is stable. */
function refineComponent(
  component: Candidate[],
): { members: Candidate[]; shape: Set<string> } | null {
  let members = component;
  while (members.length >= L.minMembers) {
    const counts = new Map<string, number>();
    for (const member of members)
      for (const token of member.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const shape = new Set(
      [...counts].filter(([, count]) => count * 2 > members.length).map(([token]) => token),
    );
    const kept = members.filter((member) => similarEnough(member.tokens, shape));
    if (kept.length === members.length)
      return shape.size >= L.minShapeFiles ? { members, shape } : null;
    members = kept;
  }
  return null;
}

function directoryFamilies(candidates: Candidate[]): RawFamily[] {
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const parent = parentOf(candidate.path);
    const bucket = buckets.get(parent) ?? [];
    bucket.push(candidate);
    buckets.set(parent, bucket);
  }
  const families: RawFamily[] = [];
  for (const parent of sorted(buckets.keys())) {
    const bucket = (buckets.get(parent) ?? []).sort((left, right) =>
      compareText(left.path, right.path),
    );
    if (bucket.length < L.minMembers) continue;
    for (const component of similarComponents(bucket)) {
      const refined = refineComponent(component);
      if (!refined) continue;
      const shape = sorted(refined.shape);
      families.push({
        id: familyId({ kind: "sibling-directories", parent, shape }),
        memberCount: refined.members.length,
        build: (counter) => {
          counter.members += Math.max(0, refined.members.length - L.maxMembersPerFamily);
          return {
            id: familyId({ kind: "sibling-directories", parent, shape }),
            kind: "sibling-directories",
            parent,
            memberCount: refined.members.length,
            shape: boundPaths(shape, L.maxShapePaths, counter),
            shapeFileCount: shape.length,
            members: refined.members.slice(0, L.maxMembersPerFamily).map((member) => {
              const missing = shape.filter((token) => !member.tokens.has(token));
              const extra = sorted(member.tokens).filter((token) => !refined.shape.has(token));
              const shared = intersectionSize(member.tokens, refined.shape);
              const union = member.tokens.size + refined.shape.size - shared;
              return {
                path: member.path,
                fileCount: member.tokens.size,
                bytes: member.bytes,
                unsizedFiles: member.unsizedFiles,
                similarityPercent: Math.floor((shared * 100) / union),
                missing: boundPaths(missing, L.maxDiffPathsPerMember, counter),
                missingCount: missing.length,
                extra: boundPaths(extra, L.maxDiffPathsPerMember, counter),
                extraCount: extra.length,
              };
            }),
          };
        },
      });
    }
  }
  return families;
}

/**
 * Name template: a numbered series (`0001-intro.md` → `#*.md`) when the stem has a digit
 * run, else a compound suffix (`a.test.ts` → `*.test.ts`), else none. Single-extension
 * siblings alone are not a family; that would flag every source folder.
 */
function nameTemplate(name: string): string | null {
  const parts = (name.startsWith(".") ? name.slice(1) : name).split(".");
  const [stem, middle, last] = [parts[0], parts.at(-2), parts.at(-1)];
  const extension = parts.length >= 2 && last && !/^\d+$/.test(last) ? `.${last}` : "";
  const base = name.slice(0, name.length - extension.length);
  const digits = /\d+/.exec(base);
  if (digits) return `${base.slice(0, digits.index)}#*${extension}`;
  return parts.length >= 3 && stem && middle && last ? `*.${middle}.${last}` : null;
}

function patternFamilies(paths: ObservedFile[]): RawFamily[] {
  const groups = new Map<string, { parent: string; pattern: string; members: typeof paths }>();
  for (const entry of paths) {
    const parent = parentOf(entry.path);
    const pattern = nameTemplate(entry.path.slice(parent === ROOT ? 0 : parent.length + 1));
    if (!pattern) continue;
    const key = `${parent}\0${pattern}`;
    const group = groups.get(key) ?? { parent, pattern, members: [] };
    group.members.push(entry);
    groups.set(key, group);
  }
  return sorted(groups.keys()).flatMap((key) => {
    const group = groups.get(key);
    if (!group || group.members.length < L.minMembers) return [];
    const { parent, pattern } = group;
    const members = [...group.members].sort((left, right) => compareText(left.path, right.path));
    const id = familyId({ kind: "file-name-pattern", parent, pattern });
    return [
      {
        id,
        memberCount: members.length,
        build: (counter: Omitted): ItemFamilyV1 => {
          const fitting = members.filter((member) => member.path.length <= L.maxPathChars);
          counter.longPaths += members.length - fitting.length;
          counter.members += Math.max(0, fitting.length - L.maxMembersPerFamily);
          return {
            id,
            kind: "file-name-pattern",
            parent,
            pattern,
            memberCount: members.length,
            members: fitting.slice(0, L.maxMembersPerFamily),
          };
        },
      },
    ];
  });
}

export function detectProgrammaticItemFamilies(inventory: InventoryV1): ProgrammaticItemFamiliesV1 {
  const parsed = inventoryV1Schema.parse(inventory);
  const paths = parsed.entries
    .filter((entry) => !entry.path.startsWith(HOST_PREFIX))
    .map((entry) => ({ path: entry.path, bytes: "bytes" in entry ? entry.bytes : null }));
  const { candidates, oversized } = directoryCandidates(paths);
  const raw = [...directoryFamilies(candidates), ...patternFamilies(paths)].sort(
    (left, right) => right.memberCount - left.memberCount || compareText(left.id, right.id),
  );
  const { minMembers, minShapeFiles, minSimilarityPercent, ...limits } = L;
  // Whole families are dropped (lowest rank first) until the serialized facts fit.
  for (let count = Math.min(raw.length, L.maxFamilies); ; count -= 1) {
    const omitted: Omitted = {
      families: raw.length - count,
      members: 0,
      longPaths: 0,
      listTruncations: 0,
      oversizedMembers: oversized,
    };
    const families = raw.slice(0, count).map((family) => family.build(omitted));
    const result: ProgrammaticItemFamiliesV1 = {
      version: PROGRAMMATIC_CONTRACT_VERSION,
      basis: "observed-paths",
      nameToken: NAME_TOKEN,
      thresholds: { minMembers, minShapeFiles, minSimilarityPercent },
      limits,
      families,
      omitted,
    };
    if (count === 0 || Buffer.byteLength(stableJson(result)) <= L.maxSerializedBytes) return result;
  }
}
