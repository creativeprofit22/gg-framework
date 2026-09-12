import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertNoCaseCollisions,
  canonicalRepositoryRoot,
  compareText,
  containedPath,
  detectHostTarget,
  normalizeRepositoryPath,
  relativeRepositoryPath,
  rejectLinks,
  sha256,
  stableJson,
} from "./paths.js";
import {
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryIssue,
  type EvidenceRole,
  type EvidenceSource,
  type HostTarget,
  type TauriCandidate,
  type TauriDiscoveryEvidence,
  type TauriDiscoveryResult,
  type TauriResource,
  type TauriSidecar,
} from "./types.js";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];
const GLOB_CHARACTERS = /[*?[\]{}]/;
const MAX_REFERENCED_FILES = 10_000;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024 * 1024;

interface JsonObject {
  [key: string]: unknown;
}

interface DiscoveryContext {
  root: string;
  host: HostTarget;
  sources: Map<string, EvidenceSource>;
  issues: DiscoveryIssue[];
}

export async function discoverTauriPackages(
  repositoryRoot: string,
  host = detectHostTarget(),
): Promise<TauriDiscoveryResult> {
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const context: DiscoveryContext = { root, host, sources: new Map(), issues: [] };
  const packageRoots = await discoverPackageRoots(context);
  const candidates: TauriCandidate[] = [];
  for (const packageRoot of packageRoots) {
    const candidate = await inspectPackage(context, packageRoot);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => compareText(left.target_id, right.target_id));
  const sources = [...context.sources.values()].sort(compareSources);
  const issues = context.issues.sort(
    (left, right) => compareText(left.path, right.path) || compareText(left.code, right.code),
  );
  const evidence: TauriDiscoveryEvidence = {
    schema_version: DISCOVERY_SCHEMA_VERSION,
    host,
    candidates,
    sources,
    issues,
  };
  const evidence_sha256 = sha256(stableJson(evidence));
  const summary =
    candidates.length === 1
      ? `Found one supported Tauri target: ${candidates[0]!.target_id}.`
      : candidates.length > 1
        ? `Found ${candidates.length} supported Tauri targets; choose an explicit target ID.`
        : issues.length
          ? `Found no supported Tauri targets (${issues.length} deterministic rejection${issues.length === 1 ? "" : "s"}).`
          : "Found no Tauri package in the declared workspace roots.";
  return { evidence, evidence_sha256, targets: candidates, summary };
}

async function discoverPackageRoots(context: DiscoveryContext): Promise<string[]> {
  const roots = new Set<string>([""]);
  const rootPackage = await readJsonEvidence(context, "package.json", "root-package", true);
  const packagePatterns = packageWorkspacePatterns(rootPackage);
  const pnpmWorkspace = await readOptionalEvidence(
    context,
    "pnpm-workspace.yaml",
    "workspace-definition",
  );
  if (pnpmWorkspace) packagePatterns.push(...parsePnpmWorkspace(pnpmWorkspace.toString("utf8")));
  for (const lockfile of LOCKFILES) await readOptionalEvidence(context, lockfile, "lockfile");
  for (const pattern of [...new Set(packagePatterns)].sort()) {
    if (pattern.startsWith("!") || pattern.includes("\\") || path.posix.isAbsolute(pattern)) {
      issue(
        context,
        "unsupported-workspace",
        "pnpm-workspace.yaml",
        `Unsupported workspace entry: ${pattern}`,
      );
      continue;
    }
    if (!GLOB_CHARACTERS.test(pattern)) {
      roots.add(normalizeRepositoryPath(pattern));
      continue;
    }
    if (!pattern.endsWith("/*") || GLOB_CHARACTERS.test(pattern.slice(0, -2))) {
      issue(
        context,
        "unsupported-workspace",
        "pnpm-workspace.yaml",
        `Only literal roots and one trailing /* are supported: ${pattern}`,
      );
      continue;
    }
    const parent = normalizeRepositoryPath(pattern.slice(0, -2));
    try {
      await rejectLinks(context.root, parent);
      const entries = await readdir(containedPath(context.root, parent), { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) roots.add(`${parent}/${entry.name}`);
      }
    } catch (error) {
      issue(context, "invalid-path", parent, errorMessage(error));
    }
  }
  const packageRoots: string[] = [];
  for (const packageRoot of [...roots].sort()) {
    const manifestPath = packageRoot ? `${packageRoot}/package.json` : "package.json";
    if (await existsContained(context.root, manifestPath)) packageRoots.push(packageRoot);
  }
  return packageRoots;
}

function packageWorkspacePatterns(rootPackage: JsonObject): string[] {
  const workspaces = rootPackage.workspaces;
  if (Array.isArray(workspaces))
    return workspaces.filter((item): item is string => typeof item === "string");
  if (isObject(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function parsePnpmWorkspace(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: string[] = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (/^[^\s]/.test(line)) inPackages = false;
    if (!inPackages) continue;
    const match = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/.exec(line);
    if (!match) throw new Error(`Unsupported pnpm-workspace.yaml packages syntax: ${rawLine}`);
    result.push(match[1] ?? match[2] ?? match[3]!);
  }
  return result;
}

async function inspectPackage(
  context: DiscoveryContext,
  packageRoot: string,
): Promise<TauriCandidate | null> {
  const packageManifest = packageRoot ? `${packageRoot}/package.json` : "package.json";
  const packageJson = await readJsonEvidence(context, packageManifest, "workspace-package", true);
  const tauriRoot = packageRoot ? `${packageRoot}/src-tauri` : "src-tauri";
  const cargoManifest = `${tauriRoot}/Cargo.toml`;
  const tauriConfig = `${tauriRoot}/tauri.conf.json`;
  const hasTauriShape =
    hasDependency(packageJson, "@tauri-apps/cli") ||
    (await existsContained(context.root, cargoManifest)) ||
    (await existsContained(context.root, tauriConfig));
  if (!hasTauriShape) return null;

  const cliDeclaration = dependencyVersion(packageJson, "@tauri-apps/cli");
  if (!cliDeclaration || majorVersion(cliDeclaration) !== 2) {
    issue(
      context,
      "unsupported-tauri-version",
      packageManifest,
      "A local @tauri-apps/cli v2 declaration is required",
    );
    return null;
  }
  if (!(await existsContained(context.root, tauriConfig))) {
    const unsupported = [
      `${tauriRoot}/tauri.conf.json5`,
      `${tauriRoot}/tauri.conf.toml`,
      `${tauriRoot}/Tauri.toml`,
    ];
    const found = await firstExisting(context.root, unsupported);
    issue(
      context,
      found ? "unsupported-config-format" : "missing-proof",
      found ?? tauriConfig,
      found ? "Only tauri.conf.json is supported" : "Missing tauri.conf.json",
    );
    return null;
  }
  if (!(await existsContained(context.root, cargoManifest))) {
    issue(context, "missing-proof", cargoManifest, "Missing Cargo.toml");
    return null;
  }

  try {
    // simplification: v1, JSON5/TOML, and cross-target support belong in explicit format/target adapters.
    await rejectLinks(context.root, packageManifest);
    await rejectLinks(context.root, cargoManifest);
    await rejectLinks(context.root, tauriConfig);
    const cargoBytes = await readEvidence(context, cargoManifest, "cargo-manifest");
    assertTauriV2Cargo(cargoBytes.toString("utf8"));
    const config = await readJsonEvidence(context, tauriConfig, "tauri-config", false);
    assertTauriV2Config(config);
    const cli = await resolveCli(context, packageRoot);
    const { resources, paths: resourcePaths } = await resolveResources(context, tauriRoot, config);
    const { sidecars, paths: sidecarPaths } = await resolveSidecars(context, tauriRoot, config);
    assertNoCaseCollisions([
      packageManifest,
      cargoManifest,
      tauriConfig,
      ...resourcePaths,
      ...sidecarPaths,
    ]);
    const productName = requiredString(config.productName, "productName", tauriConfig);
    const identifier = requiredString(config.identifier, "identifier", tauriConfig);
    const target_id = `tauri-${sha256(stableJson({ packageManifest, cargoManifest, tauriConfig, host: context.host })).slice(0, 20)}`;
    const sourcePaths = [
      packageManifest,
      cargoManifest,
      tauriConfig,
      cli.packagePath,
      cli.binPath,
      ...resourcePaths,
      ...sidecarPaths,
    ].sort();
    return {
      target_id,
      package_root: packageRoot || ".",
      package_manifest: packageManifest,
      cargo_manifest: cargoManifest,
      tauri_config: tauriConfig,
      cli_package: cli.packagePath,
      cli_bin: cli.binPath,
      cli_version: cli.version,
      product_name: productName,
      identifier,
      host: context.host,
      artifact_root: `artifacts/tauri/${target_id}`,
      resources,
      sidecars,
      prune: [],
      required_roles: [
        { role: "app", minimum: 1, directly_runnable: true },
        { role: "bundle", minimum: 0, directly_runnable: false },
      ],
      source_paths: sourcePaths,
    };
  } catch (error) {
    const message = errorMessage(error);
    const code = classifyIssue(message);
    issue(context, code, packageManifest, message);
    return null;
  }
}

function assertTauriV2Cargo(source: string): void {
  const sections = parseTomlSections(source);
  const tauri = sections.get("dependencies")?.get("tauri");
  const tauriBuild = sections.get("build-dependencies")?.get("tauri-build");
  if (!tauri || !tauriBuild)
    throw new Error("Cargo.toml must declare tauri and tauri-build directly");
  if (
    majorVersion(extractTomlVersion(tauri)) !== 2 ||
    majorVersion(extractTomlVersion(tauriBuild)) !== 2
  ) {
    throw new Error(
      "Tauri v1 Cargo dependencies are unsupported; tauri and tauri-build must be v2",
    );
  }
}

function parseTomlSections(source: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section = "";
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const clean = stripTomlComment(line).trim();
    const sectionMatch = /^\[([^\]]+)]$/.exec(clean);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(clean);
    if (assignment && sections.has(section))
      sections.get(section)!.set(assignment[1]!, assignment[2]!);
  }
  return sections;
}

function stripTomlComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (character === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function extractTomlVersion(value: string): string {
  const direct = /^['"]([^'"]+)['"]$/.exec(value);
  if (direct) return direct[1]!;
  const table = /\bversion\s*=\s*['"]([^'"]+)['"]/.exec(value);
  if (table) return table[1]!;
  throw new Error("Cargo dependency must contain a literal version");
}

function assertTauriV2Config(config: JsonObject): void {
  const schema = config.$schema;
  if (typeof schema === "string" && /(?:config\/1|config\.schema\.json.*v1)/i.test(schema)) {
    throw new Error("Tauri v1 configuration is unsupported");
  }
  if (isObject(config.build) && config.build.target !== undefined) {
    throw new Error(
      "Cross-target configuration is unsupported; package the native host target only",
    );
  }
  if (!isObject(config.bundle) && config.bundle !== undefined)
    throw new Error("bundle must be an object");
}

async function resolveCli(context: DiscoveryContext, packageRoot: string) {
  const candidates = [
    packageRoot
      ? `${packageRoot}/node_modules/@tauri-apps/cli/package.json`
      : "node_modules/@tauri-apps/cli/package.json",
    "node_modules/@tauri-apps/cli/package.json",
  ];
  for (const packagePath of [...new Set(candidates)]) {
    if (!(await existsContained(context.root, packagePath))) continue;
    const absolutePackage = containedPath(context.root, packagePath);
    const canonicalPackage = await realpath(absolutePackage);
    relativeRepositoryPath(context.root, canonicalPackage);
    const cliPackage = await readJsonEvidence(context, packagePath, "tauri-cli-package", false);
    const version = requiredString(cliPackage.version, "version", packagePath);
    if (majorVersion(version) !== 2)
      throw new Error(`Installed @tauri-apps/cli must be v2: ${packagePath}`);
    const bin = cliPackage.bin;
    const binValue = isObject(bin) ? bin.tauri : undefined;
    if (typeof binValue !== "string")
      throw new Error(`Installed CLI has no literal bin.tauri: ${packagePath}`);
    const packageDirectory = path.posix.dirname(packagePath);
    const binPath = normalizeRepositoryPath(path.posix.join(packageDirectory, binValue));
    const canonicalDirectory = path.dirname(canonicalPackage);
    const canonicalBin = await realpath(containedPath(context.root, binPath));
    const relativeToPackage = path.relative(canonicalDirectory, canonicalBin);
    if (relativeToPackage.startsWith("..") || path.isAbsolute(relativeToPackage)) {
      throw new Error(`CLI bin escapes its package: ${binPath}`);
    }
    await readEvidence(context, binPath, "tauri-cli-bin");
    return { packagePath, binPath, version };
  }
  throw new Error("No locally installed @tauri-apps/cli package was found");
}

async function resolveResources(
  context: DiscoveryContext,
  tauriRoot: string,
  config: JsonObject,
): Promise<{ resources: TauriResource[]; paths: string[] }> {
  const bundle = isObject(config.bundle) ? config.bundle : {};
  const configured = bundle.resources;
  if (configured === undefined) return { resources: [], paths: [] };
  const entries: Array<[string, string]> = [];
  if (Array.isArray(configured)) {
    for (const source of configured) {
      if (typeof source !== "string") throw new Error("Resource entries must be literal strings");
      entries.push([source, source]);
    }
  } else if (isObject(configured)) {
    for (const [source, target] of Object.entries(configured)) {
      if (typeof target !== "string")
        throw new Error("Resource map targets must be literal strings");
      entries.push([source, target]);
    }
  } else {
    throw new Error("bundle.resources must be a string list or source-target map");
  }
  const resources: TauriResource[] = [];
  const paths: string[] = [];
  for (const [configuredSource, configuredTarget] of entries.sort(([a], [b]) =>
    compareText(a, b),
  )) {
    const source = resolveConfigLiteral(tauriRoot, configuredSource);
    const target = normalizeLiteral(configuredTarget);
    const absolute = await rejectLinks(context.root, source);
    const info = await stat(absolute);
    if (!info.isFile() && !info.isDirectory())
      throw new Error(`Resource is not a file or directory: ${source}`);
    const evidencePaths = info.isDirectory()
      ? await collectDirectoryEvidence(context, source, "resource")
      : [await addExistingEvidence(context, source, "resource")];
    paths.push(...evidencePaths);
    resources.push({ source, target, kind: info.isDirectory() ? "directory" : "file" });
  }
  return { resources, paths: [...new Set(paths)].sort() };
}

async function resolveSidecars(
  context: DiscoveryContext,
  tauriRoot: string,
  config: JsonObject,
): Promise<{ sidecars: TauriSidecar[]; paths: string[] }> {
  const bundle = isObject(config.bundle) ? config.bundle : {};
  const configured = bundle.externalBin ?? bundle["external-bin"];
  if (configured === undefined) return { sidecars: [], paths: [] };
  if (!Array.isArray(configured) || configured.some((item) => typeof item !== "string")) {
    throw new Error("bundle.externalBin must be a literal string list");
  }
  const sidecars: TauriSidecar[] = [];
  const paths: string[] = [];
  for (const configuredSource of [...configured].sort() as string[]) {
    const base = resolveConfigLiteral(tauriRoot, configuredSource);
    const extension = context.host.platform === "win32" ? ".exe" : "";
    const source = `${base}-${context.host.rust_triple}${extension}`;
    await rejectLinks(context.root, source);
    paths.push(await addExistingEvidence(context, source, "sidecar"));
    sidecars.push({ configured_source: base, source });
  }
  return { sidecars, paths };
}

function resolveConfigLiteral(tauriRoot: string, value: string): string {
  return normalizeRepositoryPath(path.posix.join(tauriRoot, normalizeLiteral(value)));
}

function normalizeLiteral(value: string): string {
  if (GLOB_CHARACTERS.test(value))
    throw new Error(`Globbed resource/sidecar paths are unsupported: ${value}`);
  if (value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Absolute or mixed-separator path is unsupported: ${value}`);
  }
  return normalizeRepositoryPath(value.replace(/\/+$/, ""));
}

async function collectDirectoryEvidence(
  context: DiscoveryContext,
  directory: string,
  role: EvidenceRole,
): Promise<string[]> {
  const found: string[] = [];
  const visit = async (repositoryPath: string): Promise<void> => {
    const entries = await readdir(containedPath(context.root, repositoryPath), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const child = `${repositoryPath}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Symbolic links are unsupported in referenced paths: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) found.push(await addExistingEvidence(context, child, role));
      else throw new Error(`Unsupported filesystem entry in resource: ${child}`);
      if (found.length > MAX_REFERENCED_FILES)
        throw new Error(`Referenced resource exceeds ${MAX_REFERENCED_FILES} files`);
    }
  };
  await visit(directory);
  assertNoCaseCollisions(found);
  return found;
}

async function addExistingEvidence(
  context: DiscoveryContext,
  repositoryPath: string,
  role: EvidenceRole,
): Promise<string> {
  await readEvidence(context, repositoryPath, role);
  return repositoryPath;
}

async function readJsonEvidence(
  context: DiscoveryContext,
  repositoryPath: string,
  role: EvidenceRole,
  permitDuplicateRole: boolean,
): Promise<JsonObject> {
  const bytes = await readEvidence(context, repositoryPath, role, permitDuplicateRole);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${repositoryPath}: ${errorMessage(error)}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`Expected a JSON object in ${repositoryPath}`);
  return parsed;
}

async function readEvidence(
  context: DiscoveryContext,
  repositoryPath: string,
  role: EvidenceRole,
  permitDuplicateRole = false,
): Promise<Buffer> {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const absolute = containedPath(context.root, normalized);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`Evidence source is not a file: ${normalized}`);
  if (info.size > MAX_EVIDENCE_FILE_BYTES)
    throw new Error(`Evidence source is too large: ${normalized}`);
  const bytes = await readFile(absolute);
  const existing = context.sources.get(normalized);
  if (existing && existing.role !== role && !permitDuplicateRole) {
    throw new Error(`Evidence source has conflicting roles: ${normalized}`);
  }
  context.sources.set(normalized, {
    path: normalized,
    role: existing?.role ?? role,
    sha256: sha256(bytes),
  });
  return bytes;
}

async function readOptionalEvidence(
  context: DiscoveryContext,
  repositoryPath: string,
  role: EvidenceRole,
): Promise<Buffer | null> {
  if (!(await existsContained(context.root, repositoryPath))) return null;
  return readEvidence(context, repositoryPath, role);
}

async function existsContained(root: string, repositoryPath: string): Promise<boolean> {
  try {
    const info = await stat(containedPath(root, repositoryPath));
    return info.isFile() || info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function firstExisting(root: string, paths: string[]): Promise<string | null> {
  for (const candidate of paths) if (await existsContained(root, candidate)) return candidate;
  return null;
}

function dependencyVersion(packageJson: JsonObject, name: string): string | null {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = packageJson[field];
    if (isObject(dependencies) && typeof dependencies[name] === "string") return dependencies[name];
  }
  return null;
}

function hasDependency(packageJson: JsonObject, name: string): boolean {
  return dependencyVersion(packageJson, name) !== null;
}

function majorVersion(version: string): number | null {
  const match = /(?:^|[^0-9])(\d+)(?:\.|$)/.exec(version);
  return match ? Number(match[1]) : null;
}

function requiredString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${source} requires non-empty ${field}`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  context: DiscoveryContext,
  code: DiscoveryIssue["code"],
  path: string,
  message: string,
): void {
  context.issues.push({ code, path, message });
}

function classifyIssue(message: string): DiscoveryIssue["code"] {
  if (/v1|must be v2/i.test(message)) return "unsupported-tauri-version";
  if (/cross-target/i.test(message)) return "unsupported-cross-target";
  if (/glob/i.test(message)) return "unsupported-glob";
  if (/symbolic link/i.test(message)) return "link-rejected";
  if (/case-collid/i.test(message)) return "case-collision";
  if (/CLI/i.test(message)) return "missing-cli";
  if (/path|escape|separator|absolute/i.test(message)) return "invalid-path";
  if (/JSON|Cargo|manifest|bundle|productName|identifier/i.test(message)) return "invalid-manifest";
  return "missing-proof";
}

function compareSources(left: EvidenceSource, right: EvidenceSource): number {
  return compareText(left.path, right.path) || compareText(left.role, right.role);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
