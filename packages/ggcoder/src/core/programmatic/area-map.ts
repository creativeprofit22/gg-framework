import type { InventoryV1 } from "./contracts.js";
import { inventoryV1Schema, PROGRAMMATIC_CONTRACT_VERSION } from "./contracts.js";
import { MANIFESTS, TASK_RUNNERS } from "./assessment-evidence.js";
import {
  detectProgrammaticItemFamilies,
  type ProgrammaticItemFamiliesV1,
} from "./item-families.js";
import { compareText, sha256, stableJson } from "../tauri-package/paths.js";

/**
 * Advisory area map: groups observed inventory paths into a bounded set of project areas
 * so assessments can search area by area. Paths, manifest names and script names only;
 * never scanner findings, settings, fingerprints, drift inputs or permission.
 */
export const AREA_MAP_LIMITS = Object.freeze({
  maxSourceFilesPerArea: 80,
  minFilesPerArea: 5,
  maxAreas: 24,
  maxSplitDepth: 4,
  maxListItems: 12,
  maxLabelChars: 120,
  maxSerializedBytes: 24 * 1024,
});

export type ProgrammaticAreaKind =
  "workspace-member" | "package" | "folder" | "name-group" | "merged" | "cross-area";

export interface AreaManifestFacts {
  path: string;
  packageName?: string;
  scriptNames: string[];
  dependencyNames: string[];
  /** Joined script commands, used only to find links between workspace members. */
  scriptText: string;
  workspacePatterns: string[];
}

export interface AreaWorkflowFacts {
  path: string;
  jobIds: string[];
}

export type AreaHistoryInput =
  | {
      status: "ok";
      sinceDays: number;
      depth: number;
      commitsRead: number;
      truncated: boolean;
      entries: { path: string; commits: number }[];
    }
  | { status: "unavailable"; reason: string };

export interface ProgrammaticAreaMapInput {
  inventory: InventoryV1;
  manifests?: AreaManifestFacts[];
  workflows?: AreaWorkflowFacts[];
  itemFamilies?: ProgrammaticItemFamiliesV1;
  history?: AreaHistoryInput;
}

export interface ProgrammaticAreaV1 {
  id: string;
  label: string;
  kind: ProgrammaticAreaKind;
  packageName: string | null;
  /** Complete; `assignProgrammaticAreas` resolves cross-area, then name groups, then the deepest folder, then `**`. */
  include: string[];
  /** Advisory only: more specific areas carved out of this one (bounded). */
  exclude: string[];
  fileCount: number;
  sourceFileCount: number;
  oversized: boolean;
  lowSignal: { reason: string } | null;
  signals: {
    scripts: string[];
    ciJobs: string[];
    commandFiles: number;
    taskRunners: string[];
    itemFamilies: { id: string; kind: string; memberCount: number }[];
    recentChanges: { folderCommits: number; partial: true } | null;
  };
  omitted: {
    scripts: number;
    ciJobs: number;
    taskRunners: number;
    itemFamilies: number;
    exclude: number;
    unsafeNames: number;
  };
}

export interface ProgrammaticAreaMapV1 {
  version: typeof PROGRAMMATIC_CONTRACT_VERSION;
  basis: "observed-paths";
  note: string;
  thresholds: {
    maxSourceFilesPerArea: number;
    minFilesPerArea: number;
    maxAreas: number;
    maxSplitDepth: number;
  };
  limits: { maxListItems: number; maxLabelChars: number; maxSerializedBytes: number };
  fileCount: number;
  areas: ProgrammaticAreaV1[];
  history:
    | {
        status: "ok";
        sinceDays: number;
        depth: number;
        commitsRead: number;
        truncated: boolean;
        unattributedFolderCommits: number;
      }
    | { status: "unavailable"; reason: string };
}

const L = AREA_MAP_LIMITS;
const ROOT = ".";
const CROSS_AREA_ID = "cross-area";
const CROSS_DIRS = [".github", ".gitlab", ".circleci", ".buildkite", ".changeset", ".husky"];
const CROSS_PREFIXES = [".gg/commands", ".claude/commands", ".gg/programmatic"];
const CROSS_INCLUDE = ["*", ...CROSS_DIRS, ...CROSS_PREFIXES].map((item) =>
  item === "*" ? item : `${item}/**`,
);
const GROUP_SUFFIX = "[-_.]*";
const NOTE =
  "Advisory area map from paths and manifest names; not scanner findings, settings or permission.";
const LOW_SIGNAL_REASON =
  "No dependency or script links to or from other workspace members; root scripts alone do not count.";
const SAFE_NAME = /^[\w:.@/-]{1,64}$/;
const COMMAND_FILE = /^\.(gg|claude)\/commands\/.+\.md$/i;
const SOURCE_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs mts cts py rs go java kt kts swift rb php cs c h cc cpp hpp m mm " +
    "scala ex exs erl dart lua sh ps1 vue svelte astro sql zig clj hs ml fs elm r jl pl"
  ).split(" "),
);

type Rule =
  | { type: "cross" }
  | { type: "subtree"; root: string }
  | { type: "group"; dir: string; prefix: string }
  | { type: "all" };

interface Draft {
  rule: Rule;
  kind: ProgrammaticAreaKind;
  splitLevel: number;
  splitParent: boolean;
  splitTried: boolean;
}

interface ResolverArea {
  key: string;
  include: readonly string[];
  cross: boolean;
}

function parentOf(repositoryPath: string): string {
  const index = repositoryPath.lastIndexOf("/");
  return index < 0 ? ROOT : repositoryPath.slice(0, index);
}

function baseName(repositoryPath: string): string {
  return repositoryPath.slice(repositoryPath.lastIndexOf("/") + 1);
}

function isUnder(repositoryPath: string, root: string): boolean {
  return root === ROOT || repositoryPath.startsWith(`${root}/`);
}

/** Basename up to its first `-`, `_` or `.`; dotfiles and names without a separator have none. */
function namePrefix(name: string): string | null {
  if (name.startsWith(".")) return null;
  return /^([^-_.]+)[-_.]/.exec(name)?.[1] ?? null;
}

function isCrossArea(repositoryPath: string): boolean {
  if (!repositoryPath.includes("/")) return true;
  const first = repositoryPath.slice(0, repositoryPath.indexOf("/"));
  return (
    CROSS_DIRS.includes(first) ||
    CROSS_PREFIXES.some((prefix) => repositoryPath.startsWith(`${prefix}/`))
  );
}

function isSource(repositoryPath: string): boolean {
  const name = baseName(repositoryPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function isPackageManifest(name: string): boolean {
  const lower = name.toLowerCase();
  return (MANIFESTS.has(lower) && lower !== "pnpm-workspace.yaml") || lower.endsWith(".csproj");
}

function ruleInclude(rule: Rule): string[] {
  if (rule.type === "cross") return [...CROSS_INCLUDE];
  if (rule.type === "all") return ["**"];
  if (rule.type === "group") return [`${rule.dir}/${rule.prefix}${GROUP_SUFFIX}`];
  return [`${rule.root}/**`];
}

function ruleKey(rule: Rule): string {
  return rule.type === "cross" ? CROSS_AREA_ID : ruleInclude(rule).join("\n");
}

function posix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** One resolver for building and for `assignProgrammaticAreas`, so both always agree. */
function createResolver(areas: readonly ResolverArea[]): (repositoryPath: string) => string | null {
  let crossKey: string | null = null;
  let crossRootFiles = false;
  const crossRoots: string[] = [];
  const groups = new Map<string, string>();
  const subtrees = new Map<string, string>();
  let allKey: string | null = null;
  for (const area of areas) {
    for (const include of area.include) {
      if (area.cross) {
        crossKey = area.key;
        if (include === "*") crossRootFiles = true;
        else if (include.endsWith("/**")) crossRoots.push(include.slice(0, -3));
      } else if (include === "**") allKey ??= area.key;
      else if (include.endsWith(GROUP_SUFFIX)) {
        const body = include.slice(0, -GROUP_SUFFIX.length);
        const slash = body.lastIndexOf("/");
        if (slash > 0) groups.set(`${body.slice(0, slash)}\0${body.slice(slash + 1)}`, area.key);
      } else if (include.endsWith("/**")) subtrees.set(include.slice(0, -3), area.key);
    }
  }
  return (repositoryPath) => {
    if (crossKey !== null) {
      if (crossRootFiles && !repositoryPath.includes("/")) return crossKey;
      if (crossRoots.some((root) => repositoryPath.startsWith(`${root}/`))) return crossKey;
    }
    let dir = parentOf(repositoryPath);
    const prefix = namePrefix(baseName(repositoryPath));
    if (prefix !== null) {
      const group = groups.get(`${dir}\0${prefix}`);
      if (group !== undefined) return group;
    }
    while (dir !== ROOT) {
      const subtree = subtrees.get(dir);
      if (subtree !== undefined) return subtree;
      dir = parentOf(dir);
    }
    return allKey;
  };
}

export function assignProgrammaticAreas(
  map: Pick<ProgrammaticAreaMapV1, "areas">,
  paths: readonly string[],
): Map<string, string | null> {
  const resolve = createResolver(
    map.areas.map((area) => ({
      key: area.id,
      include: area.include,
      cross: area.kind === "cross-area",
    })),
  );
  return new Map(paths.map((item) => [item, resolve(posix(item))]));
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function workspaceMembers(patterns: string[], packageDirs: Set<string>): Set<string> {
  const clean = (value: string) => posix(value).replace(/^\.\//, "").replace(/\/+$/, "");
  const positive = patterns
    .filter((item) => !item.startsWith("!"))
    .map(clean)
    .filter(Boolean);
  const negative = patterns
    .filter((item) => item.startsWith("!"))
    .map((item) => clean(item.slice(1)));
  const include = positive.map(globRegex);
  const exclude = negative.filter(Boolean).map(globRegex);
  const members = new Set<string>();
  for (const dir of packageDirs) {
    if (dir === ROOT) continue;
    if (include.some((regex) => regex.test(dir)) && !exclude.some((regex) => regex.test(dir)))
      members.add(dir);
  }
  return members;
}

function assignAll(drafts: Draft[], files: string[]) {
  const resolve = createResolver(
    drafts.map((draft) => ({
      key: ruleKey(draft.rule),
      include: ruleInclude(draft.rule),
      cross: draft.rule.type === "cross",
    })),
  );
  const byKey = new Map<string, string[]>();
  for (const file of files) {
    const key = resolve(file);
    if (key === null) throw new Error("Area map left a file unassigned");
    const list = byKey.get(key) ?? [];
    list.push(file);
    byKey.set(key, list);
  }
  return byKey;
}

function dropEmpty(drafts: Draft[], files: string[]): Map<string, string[]> {
  const assigned = assignAll(drafts, files);
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index];
    if (draft && draft.rule.type !== "cross" && !assigned.has(ruleKey(draft.rule)))
      drafts.splice(index, 1);
  }
  return assigned;
}

function draftRoot(draft: Draft): string {
  const { rule } = draft;
  return rule.type === "subtree" ? rule.root : rule.type === "group" ? rule.dir : ROOT;
}

function ensureCatchAll(drafts: Draft[]) {
  if (!drafts.some((draft) => draft.rule.type === "all"))
    drafts.push({
      rule: { type: "all" },
      kind: "merged",
      splitLevel: 0,
      splitParent: false,
      splitTried: true,
    });
}

function mergeTiny(drafts: Draft[], files: string[]) {
  for (;;) {
    const assigned = dropEmpty(drafts, files);
    const count = (draft: Draft) => assigned.get(ruleKey(draft.rule))?.length ?? 0;
    const tiny = drafts
      .filter(
        (draft) =>
          draft.rule.type === "subtree" && !draft.splitParent && count(draft) < L.minFilesPerArea,
      )
      .sort((left, right) => compareText(draftRoot(left), draftRoot(right)));
    if (tiny.length === 0) return;
    const subtreeRoots = new Set(
      drafts.flatMap((draft) => (draft.rule.type === "subtree" ? [draft.rule.root] : [])),
    );
    const folded = tiny.filter((draft) => {
      for (let dir = parentOf(draftRoot(draft)); dir !== ROOT; dir = parentOf(dir))
        if (subtreeRoots.has(dir)) return true;
      return false;
    });
    if (folded.length > 0) {
      for (const draft of folded) drafts.splice(drafts.indexOf(draft), 1);
      continue;
    }
    const siblings = new Map<string, Draft[]>();
    for (const draft of tiny) {
      const parent = parentOf(draftRoot(draft));
      siblings.set(parent, [...(siblings.get(parent) ?? []), draft]);
    }
    for (const [parent, group] of [...siblings].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      for (const draft of group) drafts.splice(drafts.indexOf(draft), 1);
      if (parent !== ROOT && group.length >= 2)
        drafts.push({
          rule: { type: "subtree", root: parent },
          kind: "merged",
          splitLevel: 0,
          splitParent: false,
          splitTried: true,
        });
      else ensureCatchAll(drafts);
    }
  }
}

function capAreas(drafts: Draft[], files: string[]) {
  for (;;) {
    const assigned = dropEmpty(drafts, files);
    if (drafts.length <= L.maxAreas) return;
    const count = (draft: Draft) => assigned.get(ruleKey(draft.rule))?.length ?? 0;
    const candidates = drafts.filter(
      (draft) => draft.rule.type === "subtree" || draft.rule.type === "group",
    );
    const byParent = new Map<string, Draft[]>();
    for (const draft of candidates) {
      const parent = draft.rule.type === "group" ? draftRoot(draft) : parentOf(draftRoot(draft));
      byParent.set(parent, [...(byParent.get(parent) ?? []), draft]);
    }
    const [parent, group] =
      [...byParent]
        .filter(([, members]) => members.length >= 2)
        .sort(
          ([leftParent, left], [rightParent, right]) =>
            right.length - left.length ||
            right.reduce((sum, item) => sum + count(item), 0) -
              left.reduce((sum, item) => sum + count(item), 0) ||
            compareText(leftParent, rightParent),
        )[0] ?? [];
    if (parent !== undefined && group !== undefined) {
      for (const draft of group) drafts.splice(drafts.indexOf(draft), 1);
      const exists = drafts.some(
        (draft) => draft.rule.type === "subtree" && draft.rule.root === parent,
      );
      if (parent === ROOT) ensureCatchAll(drafts);
      else if (!exists)
        drafts.push({
          rule: { type: "subtree", root: parent },
          kind: "merged",
          splitLevel: 0,
          splitParent: false,
          splitTried: true,
        });
      continue;
    }
    const smallest = [...candidates].sort(
      (left, right) =>
        count(left) - count(right) || compareText(ruleKey(left.rule), ruleKey(right.rule)),
    )[0];
    if (!smallest) return;
    drafts.splice(drafts.indexOf(smallest), 1);
    ensureCatchAll(drafts);
  }
}

function splitCandidates(files: string[], root: string): { rule: Rule; count: number }[] {
  let dir = root;
  for (let step = 0; step < 16; step += 1) {
    const subs = new Set<string>();
    let direct = 0;
    for (const file of files) {
      if (!isUnder(file, dir)) continue;
      const rest = dir === ROOT ? file : file.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash < 0) direct += 1;
      else subs.add(rest.slice(0, slash));
    }
    const [only] = subs;
    if (subs.size !== 1 || direct !== 0 || only === undefined) break;
    dir = dir === ROOT ? only : `${dir}/${only}`;
  }
  const subCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const file of files) {
    if (!isUnder(file, dir)) continue;
    const rest = dir === ROOT ? file : file.slice(dir.length + 1);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const sub = rest.slice(0, slash);
      subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
    } else if (dir !== ROOT) {
      const prefix = namePrefix(rest);
      if (prefix !== null) groupCounts.set(prefix, (groupCounts.get(prefix) ?? 0) + 1);
    }
  }
  const result: { rule: Rule; count: number }[] = [];
  for (const [sub, count] of subCounts)
    if (count >= L.minFilesPerArea)
      result.push({ rule: { type: "subtree", root: dir === ROOT ? sub : `${dir}/${sub}` }, count });
  for (const [prefix, count] of groupCounts)
    if (count >= L.minFilesPerArea) result.push({ rule: { type: "group", dir, prefix }, count });
  return result.sort(
    (left, right) =>
      right.count - left.count || compareText(ruleKey(left.rule), ruleKey(right.rule)),
  );
}

function splitLarge(drafts: Draft[], files: string[]) {
  for (;;) {
    const assigned = assignAll(drafts, files);
    const sources = (draft: Draft) =>
      (assigned.get(ruleKey(draft.rule)) ?? []).filter(isSource).length;
    const target = drafts
      .filter(
        (draft) =>
          draft.rule.type === "subtree" &&
          draft.kind !== "merged" &&
          !draft.splitTried &&
          draft.splitLevel < L.maxSplitDepth &&
          sources(draft) > L.maxSourceFilesPerArea,
      )
      .sort(
        (left, right) =>
          sources(right) - sources(left) || compareText(draftRoot(left), draftRoot(right)),
      )[0];
    if (!target) return;
    target.splitTried = true;
    const existing = new Set(drafts.map((draft) => ruleKey(draft.rule)));
    const room = L.maxAreas - drafts.length;
    const children = splitCandidates(assigned.get(ruleKey(target.rule)) ?? [], draftRoot(target))
      .filter((candidate) => !existing.has(ruleKey(candidate.rule)))
      .slice(0, Math.max(0, room));
    if (children.length === 0) continue;
    target.splitParent = true;
    for (const child of children)
      drafts.push({
        rule: child.rule,
        kind: child.rule.type === "group" ? "name-group" : "folder",
        splitLevel: target.splitLevel + 1,
        splitParent: false,
        splitTried: child.rule.type === "group",
      });
  }
}

function bounded<T>(items: T[], cap: number): { items: T[]; omitted: number } {
  return { items: items.slice(0, cap), omitted: Math.max(0, items.length - cap) };
}

function truncateLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length <= L.maxLabelChars
    ? label
    : `${chars.slice(0, L.maxLabelChars - 1).join("")}…`;
}

function wordPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w@/.-])${escaped}(?:$|[^\\w@/-])`);
}

function lowSignalMembers(members: Set<string>, manifests: Map<string, AreaManifestFacts>) {
  const known = [...members].sort(compareText).flatMap((dir) => {
    const facts = manifests.get(`${dir}/package.json`);
    return facts ? [{ dir, facts }] : [];
  });
  if (members.size < 3) return new Set<string>();
  const linked = new Set<string>();
  for (const from of known) {
    for (const to of known) {
      if (from === to) continue;
      const name = to.facts.packageName;
      const byDependency = name !== undefined && from.facts.dependencyNames.includes(name);
      const text = from.facts.scriptText;
      const byScript =
        text.includes(to.dir) ||
        (name !== undefined && name.length >= 3 && wordPattern(name).test(text)) ||
        text.includes(`../${baseName(to.dir)}/`) ||
        wordPattern(`../${baseName(to.dir)}`).test(text);
      if (byDependency || byScript) {
        linked.add(from.dir);
        linked.add(to.dir);
      }
    }
  }
  return new Set(known.filter(({ dir }) => !linked.has(dir)).map(({ dir }) => dir));
}

function folderOf(file: string, depth: number): string {
  const dirs = file.split("/").slice(0, -1);
  return dirs.length === 0 ? ROOT : dirs.slice(0, depth).join("/");
}

function safeNames(values: Iterable<string>): { names: string[]; unsafe: number } {
  const names = new Set<string>();
  let unsafe = 0;
  for (const value of values) {
    if (SAFE_NAME.test(value)) names.add(value);
    else unsafe += 1;
  }
  return { names: [...names].sort(compareText), unsafe };
}

export function buildProgrammaticAreaMap(input: ProgrammaticAreaMapInput): ProgrammaticAreaMapV1 {
  const inventory = inventoryV1Schema.parse(input.inventory);
  const files = inventory.entries.map((entry) => entry.path).sort(compareText);
  const manifests = new Map(
    (input.manifests ?? []).map((facts) => [
      posix(facts.path),
      { ...facts, path: posix(facts.path) },
    ]),
  );
  const families = input.itemFamilies ?? detectProgrammaticItemFamilies(inventory);

  const packageJsonDirs = new Set(
    files.filter((file) => baseName(file) === "package.json").map(parentOf),
  );
  const patterns = [...manifests.values()]
    .filter((facts) => !facts.path.includes("/"))
    .flatMap((facts) => facts.workspacePatterns);
  const members = new Set(
    [...workspaceMembers(patterns, packageJsonDirs)].filter((dir) => !isCrossArea(`${dir}/x`)),
  );
  const roots = new Map<string, ProgrammaticAreaKind>();
  for (const file of files) {
    if (isCrossArea(file) || !isPackageManifest(baseName(file))) continue;
    const dir = parentOf(file);
    roots.set(dir, members.has(dir) ? "workspace-member" : "package");
  }
  for (const file of files) {
    if (isCrossArea(file)) continue;
    let covered = false;
    for (let dir = parentOf(file); dir !== ROOT && !covered; dir = parentOf(dir))
      covered = roots.has(dir);
    const top = file.slice(0, file.indexOf("/"));
    if (!covered && !roots.has(top)) roots.set(top, "folder");
  }
  const drafts: Draft[] = [
    {
      rule: { type: "cross" },
      kind: "cross-area",
      splitLevel: 0,
      splitParent: false,
      splitTried: true,
    },
    ...[...roots]
      .sort(([left], [right]) => compareText(left, right))
      .map(([root, kind]): Draft => ({
        rule: { type: "subtree", root },
        kind,
        splitLevel: 0,
        splitParent: false,
        splitTried: false,
      })),
  ];
  mergeTiny(drafts, files);
  capAreas(drafts, files);
  splitLarge(drafts, files);
  const assigned = dropEmpty(drafts, files);

  const lowSignal = lowSignalMembers(members, manifests);
  const keyOf = createResolver(
    drafts.map((draft) => ({
      key: ruleKey(draft.rule),
      include: ruleInclude(draft.rule),
      cross: draft.rule.type === "cross",
    })),
  );
  const scripts = new Map<string, string[]>();
  for (const facts of [...manifests.values()].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    const key = keyOf(facts.path);
    if (key !== null) scripts.set(key, [...(scripts.get(key) ?? []), ...facts.scriptNames]);
  }
  const ciJobs = new Map<string, string[]>();
  for (const workflow of input.workflows ?? []) {
    const path = posix(workflow.path);
    const key = keyOf(path);
    if (key !== null)
      ciJobs.set(key, [
        ...(ciJobs.get(key) ?? []),
        ...workflow.jobIds.map((job) => `${baseName(path)}:${job}`),
      ]);
  }
  const familyAreas = new Map<string, { id: string; kind: string; memberCount: number }[]>();
  for (const family of families.families) {
    const key = keyOf(family.parent === ROOT ? "\0" : `${family.parent}/\0`);
    if (key !== null)
      familyAreas.set(key, [
        ...(familyAreas.get(key) ?? []),
        { id: family.id, kind: family.kind, memberCount: family.memberCount },
      ]);
  }

  const history = input.history;
  const folderCommits = new Map<string, number>();
  let unattributed = 0;
  if (history?.status === "ok") {
    const owners = new Map<string, Set<string>>();
    for (const [key, list] of assigned)
      for (const file of list) {
        const folder = folderOf(file, history.depth);
        owners.set(folder, (owners.get(folder) ?? new Set()).add(key));
      }
    for (const entry of history.entries) {
      const folder = posix(entry.path);
      const areaKeys = owners.get(folder);
      const [only] = areaKeys ?? [];
      if (areaKeys?.size === 1 && only !== undefined)
        folderCommits.set(only, (folderCommits.get(only) ?? 0) + entry.commits);
      else unattributed += entry.commits;
    }
  }

  const ordered = drafts
    .map((draft) => {
      const key = ruleKey(draft.rule);
      const list = assigned.get(key) ?? [];
      const root = draftRoot(draft);
      const isLowSignal = draft.rule.type === "subtree" && lowSignal.has(root);
      return { draft, key, list, root, isLowSignal };
    })
    .sort(
      (left, right) =>
        Number(right.draft.rule.type === "cross") - Number(left.draft.rule.type === "cross") ||
        Number(left.isLowSignal) - Number(right.isLowSignal) ||
        right.list.length - left.list.length ||
        compareText(left.key, right.key),
    );

  const build = (cap: number): ProgrammaticAreaMapV1 => ({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    basis: "observed-paths",
    note: NOTE,
    thresholds: {
      maxSourceFilesPerArea: L.maxSourceFilesPerArea,
      minFilesPerArea: L.minFilesPerArea,
      maxAreas: L.maxAreas,
      maxSplitDepth: L.maxSplitDepth,
    },
    limits: {
      maxListItems: L.maxListItems,
      maxLabelChars: L.maxLabelChars,
      maxSerializedBytes: L.maxSerializedBytes,
    },
    fileCount: files.length,
    areas: ordered.map(({ draft, key, list, root, isLowSignal }) => {
      const include = ruleInclude(draft.rule);
      const exclude =
        draft.rule.type === "subtree"
          ? ordered
              .filter(
                (other) =>
                  other.key !== key &&
                  other.draft.rule.type !== "cross" &&
                  other.draft.rule.type !== "all" &&
                  (other.root === root || isUnder(other.root, root)) &&
                  !(other.draft.rule.type === "subtree" && other.root === root),
              )
              .flatMap((other) => ruleInclude(other.draft.rule))
              .sort(compareText)
          : [];
      const scriptNames = safeNames(scripts.get(key) ?? []);
      const jobNames = safeNames(ciJobs.get(key) ?? []);
      const runners = [
        ...new Set(
          list.map((file) => baseName(file).toLowerCase()).filter((name) => TASK_RUNNERS.has(name)),
        ),
      ].sort(compareText);
      const familyList = [...(familyAreas.get(key) ?? [])].sort(
        (left, right) => right.memberCount - left.memberCount || compareText(left.id, right.id),
      );
      const [scriptsOut, jobsOut, runnersOut, familiesOut, excludeOut] = [
        bounded(scriptNames.names, cap),
        bounded(jobNames.names, cap),
        bounded(runners, cap),
        bounded(familyList, cap),
        bounded(exclude, cap),
      ] as const;
      const manifest =
        draft.rule.type === "subtree" ? manifests.get(`${root}/package.json`) : undefined;
      const packageName =
        manifest?.packageName !== undefined && SAFE_NAME.test(manifest.packageName)
          ? manifest.packageName
          : null;
      const kind = draft.kind;
      const label =
        draft.rule.type === "cross"
          ? "Root, CI, release and command files"
          : draft.rule.type === "all"
            ? "Other small folders"
            : draft.rule.type === "group"
              ? `${draft.rule.dir}/${draft.rule.prefix}*`
              : root;
      return {
        id:
          draft.rule.type === "cross"
            ? CROSS_AREA_ID
            : sha256(stableJson({ version: PROGRAMMATIC_CONTRACT_VERSION, kind, include })).slice(
                0,
                16,
              ),
        label: truncateLabel(label),
        kind,
        packageName,
        include,
        exclude: excludeOut.items,
        fileCount: list.length,
        sourceFileCount: list.filter(isSource).length,
        oversized: list.filter(isSource).length > L.maxSourceFilesPerArea,
        lowSignal: isLowSignal ? { reason: LOW_SIGNAL_REASON } : null,
        signals: {
          scripts: scriptsOut.items,
          ciJobs: jobsOut.items,
          commandFiles: list.filter((file) => COMMAND_FILE.test(file)).length,
          taskRunners: runnersOut.items,
          itemFamilies: familiesOut.items,
          recentChanges:
            history?.status === "ok"
              ? { folderCommits: folderCommits.get(key) ?? 0, partial: true as const }
              : null,
        },
        omitted: {
          scripts: scriptsOut.omitted,
          ciJobs: jobsOut.omitted,
          taskRunners: runnersOut.omitted,
          itemFamilies: familiesOut.omitted,
          exclude: excludeOut.omitted,
          unsafeNames: scriptNames.unsafe + jobNames.unsafe,
        },
      };
    }),
    history:
      history?.status === "ok"
        ? {
            status: "ok",
            sinceDays: history.sinceDays,
            depth: history.depth,
            commitsRead: history.commitsRead,
            truncated: history.truncated,
            unattributedFolderCommits: unattributed,
          }
        : {
            status: "unavailable",
            reason:
              history && /^[a-z-]{1,40}$/.test(history.reason) ? history.reason : "not-requested",
          },
  });
  // Lists shrink until the map fits; areas are never dropped, so every file keeps one area.
  for (let cap = L.maxListItems; cap > 0; cap -= 1) {
    const result = build(cap);
    if (Buffer.byteLength(stableJson(result)) <= L.maxSerializedBytes) return result;
  }
  return build(0);
}
