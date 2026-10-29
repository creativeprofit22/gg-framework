import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import {
  safeRetrievalUrl,
  type InspectedLocalLocation,
  type RetrievalResource,
} from "../../tools/retrieval-metadata.js";
import type { AdvisoryCommandPage } from "../command-discovery.js";
import { ProgrammaticSetupInspection, SETUP_ASSESSMENT_TOOLS } from "./setup-inspection.js";
import {
  POSITIVE_ADVISORY_CHOICES,
  programmaticAssessmentResultV2Schema,
  programmaticCommandSnapshotV1Schema,
  repositoryRelativePathSchema,
} from "./contracts.js";

export const ADVISORY_LIMITS = {
  pages: 10,
  metadataChars: 320_000,
  bodies: 12,
  receipts: 64,
  recommendations: 10,
  resultChars: 64_000,
} as const;
export const ADVISORY_READ_TOOLS = new Set([
  "read",
  "find",
  "grep",
  "ls",
  "code_search",
  "code_nav",
  "web_search",
  "web_fetch",
  "command_information",
  "research_corpus",
  "programmatic_advisory_result",
  "programmatic_scan",
]);
type Assessment = z.infer<typeof programmaticAssessmentResultV2Schema>;
type ProgrammaticCommandSnapshotV1 = z.infer<typeof programmaticCommandSnapshotV1Schema>;
type External = {
  tool: "steroids" | "web";
  sourceUri: string;
  repository?: string;
  path?: string;
  revision?: string;
  toolCallId: string;
};
export interface AdvisoryReceipt {
  id: string;
  toolCallId: string;
  tool: string;
  status: "retrieved" | "lead" | "failed" | "cancelled";
  /** Host retrieval time; absent on older retained receipts. */
  retrievedAt?: string;
  location?: string;
  range?: { startLine: number; endLine: number };
  external?: External;
  /** Complete local source chunks delivered by the host; never parsed from headers. */
  locations?: InspectedLocalLocation[];
  /** Host-classified owner purpose, not source/model labels or semantic relevance. */
  localSources?: { path: string; purpose: "command-definition" | "independent" | "unknown" }[];
}

/** Exact delivered identity; external receipts currently carry no verified line ranges. */
export function deliveredExternalReceipt(
  receipts: AdvisoryReceipt[],
  citation: {
    inspectedUrl: string;
    revision?: string;
    location?: { path: string; startLine?: number; endLine?: number };
  },
): AdvisoryReceipt | undefined {
  return receipts.find(
    (receipt) =>
      receipt.status === "retrieved" &&
      receipt.external?.sourceUri === citation.inspectedUrl &&
      (!citation.revision || receipt.external.revision === citation.revision) &&
      (!citation.location ||
        (receipt.external.path === citation.location.path &&
          citation.location.startLine === undefined &&
          citation.location.endLine === undefined)),
  );
}

export function localLocations(
  receipt: AdvisoryReceipt | undefined,
): { path: string; startLine?: number; endLine?: number }[] {
  if (receipt?.status !== "retrieved") return [];
  return (
    receipt.locations ?? (receipt.location ? [{ path: receipt.location, ...receipt.range }] : [])
  );
}

function hasLocalInspection(
  receipt: AdvisoryReceipt | undefined,
  cited?: { path: string },
): boolean {
  return localLocations(receipt).some(
    (location) =>
      (!cited || location.path === cited.path) &&
      receipt?.localSources?.some(
        (source) => source.path === location.path && source.purpose === "independent",
      ),
  );
}
/** A complete independent local chunk at the reference path or inside that member directory. */
function inspectedWithin(receipts: AdvisoryReceipt[], reference: string): boolean {
  return receipts.some((receipt) =>
    localLocations(receipt).some(
      (location) =>
        (location.path === reference || location.path.startsWith(`${reference}/`)) &&
        hasLocalInspection(receipt, location),
    ),
  );
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
const safeText = (value: string) =>
  Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");

/** Bounded session-only receipts; no source bodies, durable store or automatic citation fetching. */
export class AdvisoryEvidence {
  private readonly receipts = new Map<string, AdvisoryReceipt>();
  clear(): void {
    this.receipts.clear();
  }
  get(id: string): AdvisoryReceipt | undefined {
    return this.receipts.get(id);
  }
  list(): AdvisoryReceipt[] {
    return [...this.receipts.values()];
  }
  retain(receipt: AdvisoryReceipt): void {
    this.receipts.set(receipt.id, receipt);
    while (this.receipts.size > ADVISORY_LIMITS.receipts)
      this.receipts.delete(this.receipts.keys().next().value!);
  }
  observe(
    cwd: string,
    tool: string,
    args: unknown,
    toolCallId: string,
    output: string,
    failed = false,
    cancelled = false,
    retrieval?: RetrievalResource,
  ): AdvisoryReceipt {
    const input = record(args);
    // Tools also report failures as text; these must not become inspected-source receipts.
    const error =
      failed ||
      /^(?:Error\b|Failed\b|Unable\b|File not found\b|Permission denied\b|Could not read\b|Binary file\b|No (?:results|matches)|\{"(?:error|status":"unavailable))/i.test(
        output.trim(),
      );
    const locations =
      tool === "code_search" && retrieval?.outcome === "retrieved"
        ? (retrieval.localLocations ?? [])
            .slice(0, 64)
            .filter((location) => repositoryRelativePathSchema.safeParse(location.path).success)
        : [];
    // LSP outlines, references, definitions and hover are navigation leads,
    // not whole inspected source, even when the tool reads files internally.
    const inspected =
      tool === "read" ||
      locations.length > 0 ||
      tool === "web_fetch" ||
      (tool === "research_corpus" && input.action === "show");
    const receipt: AdvisoryReceipt = {
      id: `receipt-${randomUUID()}`,
      retrievedAt: new Date().toISOString(),
      toolCallId: toolCallId.slice(0, 128),
      tool,
      status: cancelled
        ? "cancelled"
        : tool === "web_fetch"
          ? failed
            ? "failed"
            : retrieval?.outcome === "retrieved"
              ? "retrieved"
              : retrieval?.outcome === "cancelled"
                ? "cancelled"
                : "failed"
          : error
            ? "failed"
            : inspected
              ? "retrieved"
              : "lead",
    };
    if (receipt.status === "retrieved" && locations.length) receipt.locations = locations;
    if (receipt.status === "retrieved" && tool === "read" && typeof input.file_path === "string") {
      const relative = path
        .relative(cwd, path.resolve(cwd, input.file_path))
        .split(path.sep)
        .join("/");
      if (repositoryRelativePathSchema.safeParse(relative).success) receipt.location = relative;
      const numbered = [...output.matchAll(/^(?:[a-f0-9]+│)?\s*(\d+)\t/gm)].map((match) =>
        Number(match[1]),
      );
      if (numbered.length)
        receipt.range = { startLine: numbered[0]!, endLine: numbered[numbered.length - 1]! };
    }
    if (
      receipt.status === "retrieved" &&
      tool === "research_corpus" &&
      typeof input.repo === "string" &&
      typeof input.path === "string" &&
      /^[\w.-]+\/[\w.-]+$/.test(input.repo) &&
      repositoryRelativePathSchema.safeParse(input.path).success
    ) {
      receipt.external = {
        tool: "steroids",
        sourceUri: `https://github.com/${input.repo}`,
        repository: input.repo,
        path: input.path,
        toolCallId: receipt.toolCallId,
      };
    }
    if (receipt.status === "retrieved" && tool === "web_fetch" && retrieval?.sourceUrl) {
      const sourceUri = safeRetrievalUrl(retrieval.sourceUrl);
      if (sourceUri) receipt.external = { tool: "web", sourceUri, toolCallId: receipt.toolCallId };
    }
    // Revision is a separate host field, never parsed from an arbitrary fetched body.
    if (
      receipt.external &&
      retrieval?.revision &&
      /^[a-zA-Z0-9._/-]{1,200}$/.test(retrieval.revision)
    )
      receipt.external.revision = retrieval.revision;
    this.retain(receipt);
    return receipt;
  }
}

type ScanSettlement = "succeeded" | "failed" | "denied" | "cancelled";
type ScanState = "not-started" | "in-flight" | "unavailable" | ScanSettlement;
export interface ProgrammaticAdvisoryPolicy {
  mode: "setup" | "configured";
  scanAvailable?: boolean;
}

/** Turn-local bookkeeping only. Semantic assessment remains in the existing model loop. */
function commandOptions(recommendation: Recommendation) {
  const choice = recommendation.choice;
  return [
    ...(choice.kind === "reuse-command" || choice.kind === "extend-command" ? [choice] : []),
    ...recommendation.alternatives.filter((option) => option.availability !== undefined),
  ];
}

export class ProgrammaticAdvisoryTurn {
  readonly limitations = new Set<string>();
  private readonly pages = new Map<
    number,
    { hash: string; next: number | null; total: number; entries: number }
  >();
  private sample = { listed: 0, excerpted: 0 };
  private readonly snapshots = new Map<string, ProgrammaticCommandSnapshotV1>();
  /** Host-delivered item families for this turn: family id → member paths. */
  private readonly families = new Map<string, ReadonlySet<string>>();
  private pageCalls = 0;
  private metadataChars = 0;
  private bodyCalls = 0;
  private scanState: ScanState = "not-started";
  private closed = false;
  submitted = false;
  private submissionPending = false;
  private readonly pendingResults = new Map<string, (complete: boolean) => void>();
  private readonly executionCleanups = new Set<() => void>();
  /** Bound abort observers and retire them even when tool promises never settle. */
  trackExecution(cleanup: () => void): () => void {
    if (!this.active || this.executionCleanups.size >= ADVISORY_LIMITS.receipts)
      throw new Error("Advisory pending execution budget unavailable.");
    this.executionCleanups.add(cleanup);
    return () => {
      this.executionCleanups.delete(cleanup);
      cleanup();
    };
  }
  /** Execution is not evidence delivery. Credit only after the loop prepares capped input. */
  stageResult(toolCallId: string, accept: (complete: boolean) => void): void {
    if (!this.active) return;
    if (this.pendingResults.size >= ADVISORY_LIMITS.receipts) {
      this.limitations.add(ADVISORY_LIMITATIONS.pendingBudget);
      return;
    }
    this.pendingResults.set(toolCallId, accept);
  }
  resultPrepared(result: Readonly<ToolResult>): void {
    const accept = this.pendingResults.get(result.toolCallId);
    if (!this.active || !accept) return;
    this.pendingResults.delete(result.toolCallId);
    const complete = !result.capped && !result.isError;
    if (!complete) this.limitations.add(ADVISORY_LIMITATIONS.delivery(!!result.capped));
    accept(complete);
  }
  readonly mode: "setup" | "configured";
  private readonly setup?: ProgrammaticSetupInspection;
  private accepted?: Assessment;
  /** The model's own coverage claim, kept for history only and never rendered. */
  reportedCoverage?: Assessment["coverage"];
  get acceptedResult(): Assessment | undefined {
    return this.accepted && structuredClone(this.accepted);
  }
  get deterministicState(): ScanState {
    return this.scanState;
  }
  allows(tool: string): boolean {
    return (
      this.active &&
      (this.mode === "setup" ? SETUP_ASSESSMENT_TOOLS.has(tool) : ADVISORY_READ_TOOLS.has(tool))
    );
  }
  constructor(
    readonly evidence: AdvisoryEvidence,
    policy: ProgrammaticAdvisoryPolicy = { mode: "configured" },
  ) {
    this.mode = policy.mode;
    if (this.mode === "setup") this.setup = new ProgrammaticSetupInspection(true);
    else if (policy.scanAvailable === false) this.markScanUnavailable();
  }
  /** Host policy boundary, before a claim only. Never converts denial/failure into a retry. */
  markScanUnavailable(): void {
    if (this.active && this.mode === "configured" && this.scanState === "not-started") {
      this.scanState = "unavailable";
      this.limitations.add(ADVISORY_LIMITATIONS.scanUnavailable);
    }
  }
  get active(): boolean {
    return !this.closed;
  }
  close(): void {
    if (this.scanState === "in-flight") this.settleScan("cancelled");
    this.closed = true;
    this.setup?.close();
    for (const cleanup of this.executionCleanups) cleanup();
    this.executionCleanups.clear();
    this.pages.clear();
    this.snapshots.clear();
    this.pendingResults.clear();
  }
  claim(tool: string, args: unknown): void {
    if (!this.allows(tool)) throw new Error("Tool unavailable in read-only advisory scope.");
    this.setup?.claimName(tool, args);
    if (tool === "programmatic_scan") {
      if (
        this.scanState !== "not-started" ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).length
      )
        throw new Error("Advisory permits one unchanged programmatic_scan with {} only.");
      this.scanState = "in-flight"; // Claim synchronously, before any approval or execution await.
    }
    if (tool !== "command_information") return;
    const input = record(args);
    if (input.action === "list") {
      if (
        ++this.pageCalls > ADVISORY_LIMITS.pages ||
        this.metadataChars >= ADVISORY_LIMITS.metadataChars
      ) {
        this.limitations.add(ADVISORY_LIMITATIONS.catalogBudget);
        throw new Error("Advisory catalog budget reached; report limited coverage.");
      }
    } else if (input.action === "resolve" && ++this.bodyCalls > ADVISORY_LIMITS.bodies) {
      this.limitations.add(ADVISORY_LIMITATIONS.bodyBudget);
      throw new Error("Advisory candidate budget reached; report limited coverage.");
    }
  }
  /**
   * Host boundary only: families from the host-run setup inspection, never model text.
   * Unrecognized shapes are ignored, so a generator recommendation cannot be accepted.
   */
  recordFamilies(value: unknown): void {
    if (this.closed) return;
    const families = record(value).families;
    if (!Array.isArray(families)) return;
    for (const family of families) {
      const { id, members } = record(family);
      if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id) || !Array.isArray(members)) continue;
      const paths = members
        .map((member) => record(member).path)
        .filter((path): path is string => typeof path === "string");
      if (paths.length === members.length) this.families.set(id, new Set(paths));
    }
  }
  /** Host execution boundary only; model result fields cannot settle the scan. */
  settleScan(outcome: ScanSettlement): void {
    if (this.closed || this.scanState !== "in-flight") return;
    this.scanState = outcome;
    if (outcome === "failed") this.limitations.add(ADVISORY_LIMITATIONS.scanFailed);
  }
  observePage(page: AdvisoryCommandPage): void {
    const serialized = JSON.stringify(page);
    this.metadataChars += serialized.length;
    if (this.metadataChars >= ADVISORY_LIMITS.metadataChars)
      this.limitations.add(ADVISORY_LIMITATIONS.catalogBudget);
    const hash = fingerprint(page);
    if (this.pages.has(page.offset) && this.pages.get(page.offset)!.hash !== hash)
      this.limitations.add(ADVISORY_LIMITATIONS.catalogChanged);
    if (page.entries.some((entry) => entry.metadataLimited || entry.bodyUnavailableReason))
      this.limitations.add(ADVISORY_LIMITATIONS.commandsUnsupported);
    this.pages.set(page.offset, {
      hash,
      next: page.nextOffset,
      total: page.total,
      entries: page.entries.length,
    });
  }
  observeCommand(output: string): void {
    try {
      const value = record(JSON.parse(output));
      if (Array.isArray(value.entries)) this.observePage(value as unknown as AdvisoryCommandPage);
      else {
        const parsed = programmaticCommandSnapshotV1Schema.safeParse(value.snapshot);
        if (value.status === "prompt" && parsed.success)
          this.snapshots.set(fingerprint(parsed.data), parsed.data);
        else
          this.limitations.add(
            value.status === "non-prompt"
              ? ADVISORY_LIMITATIONS.appCommandsUnjudged
              : ADVISORY_LIMITATIONS.commandUnreadable,
          );
      }
    } catch {
      this.limitations.add(ADVISORY_LIMITATIONS.commandsUnreadable);
    }
  }
  /** Host facts about the initial sample, used only for the plain coverage line. */
  recordSample(sample: { listed: number; excerpted: number }): void {
    this.sample = { listed: sample.listed, excerpted: sample.excerpted };
  }
  /** Plain coverage from host facts only; model coverage text is never shown. */
  hostCoverage(limitations: ReadonlySet<string>): Assessment["coverage"] {
    const read = new Set<string>();
    for (const receipt of this.evidence.list())
      for (const location of localLocations(receipt))
        if (hasLocalInspection(receipt, location)) read.add(location.path);
    const seen = [...this.pages.values()].reduce((sum, page) => sum + page.entries, 0);
    const total = this.pages.get(0)?.total ?? 0;
    const unread = Math.max(0, this.sample.listed - this.sample.excerpted);
    const parts = [
      ...(this.sample.excerpted ? [count(this.sample.excerpted, "sampled project file")] : []),
      `${count(read.size, `${this.sample.excerpted ? "more " : ""}project file`)} AI opened itself`,
      total ? `${seen} of ${count(total, "command")} in your list` : "no commands in your list",
      ...(this.snapshots.size ? [`the full text of ${count(this.snapshots.size, "command")}`] : []),
    ];
    const scope = `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.${
      unread ? ` ${count(unread, "listed file")} ${unread === 1 ? "wasn't" : "weren't"} read.` : ""
    }`;
    if (!limitations.size) return { status: "complete", scope };
    const lines = [...limitations];
    const kept: string[] = [];
    let length = 0;
    for (const [index, line] of lines.entries()) {
      const rest = lines.length - index - 1;
      const tail = rest ? ` And ${count(rest, "more limit")}.`.length : 0;
      if (length + line.length + 1 + tail > 4_000) break;
      kept.push(line);
      length += line.length + 1;
    }
    const more = lines.length - kept.length;
    return {
      status: "limited",
      scope,
      reason: [...kept, ...(more ? [`And ${count(more, "more limit")}.`] : [])].join(" "),
    };
  }
  private fullCoverage(): boolean {
    let offset = 0;
    const total = this.pages.get(0)?.total;
    for (let index = 0; index < ADVISORY_LIMITS.pages; index++) {
      const page = this.pages.get(offset);
      if (!page || page.total !== total) return false;
      if (page.next === null) return true;
      if (page.next <= offset) return false;
      offset = page.next;
    }
    return false;
  }
  async submit(
    input: unknown,
    checks: {
      snapshot: (snapshot: ProgrammaticCommandSnapshotV1) => Promise<boolean>;
      page: (offset: number) => Promise<unknown>;
      signal: AbortSignal;
    },
  ): Promise<string> {
    if (this.closed) throw new Error("Advisory scope has ended.");
    checks.signal.throwIfAborted();
    if (this.submitted || this.submissionPending)
      throw new Error("Only one validated advisory presentation is permitted per turn.");
    if (
      this.mode === "configured" &&
      (this.scanState === "not-started" || this.scanState === "in-flight")
    )
      throw new Error(
        "The required deterministic scan attempt must settle before advisory submission.",
      );
    if (this.scanState === "denied" || this.scanState === "cancelled")
      throw new Error(
        "The deterministic scan was denied or cancelled; advisory submission is unavailable. Do not retry the scan or repair setup in this turn.",
      );
    if (this.pendingResults.size)
      throw new Error(
        "Evidence results are awaiting post-cap preparation; submit in a later model turn.",
      );
    this.submissionPending = true;
    try {
      if (JSON.stringify(input).length > ADVISORY_LIMITS.resultChars)
        throw new Error("Advisory result exceeds 64,000 characters.");
      const result = programmaticAssessmentResultV2Schema.parse(input);
      if (result.recommendations.length > ADVISORY_LIMITS.recommendations)
        throw new Error("At most 10 advisory recommendations are permitted.");
      // Validate every rule first so one corrected resubmission is enough.
      const failures: string[] = [];
      for (const [index, recommendation] of result.recommendations.entries()) {
        const fail = (message: string) => {
          const line = `Idea ${index + 1}: ${message}`;
          if (!failures.includes(line)) failures.push(line);
        };
        for (const item of recommendation.evidence.items) {
          if ("kind" in item) {
            if (!deliveredExternalReceipt(this.evidence.list(), item))
              fail(
                "External provenance must match an inspected host receipt; search leads and unsupplied revisions are not evidence.",
              );
            continue;
          }
          if (item.basis === "assumed" && item.source === "assumption") continue;
          const receipt = this.evidence.get(item.source);
          if (!receipt) {
            fail(
              "Evidence source must reference a retained host receipt ID (or an explicit assumption).",
            );
            continue;
          }
          if (item.basis === "observed" && receipt.status !== "retrieved")
            fail("Search leads and failed calls cannot substantiate observed evidence.");
          const cited = item.location;
          if (
            cited &&
            !localLocations(receipt).some(
              (location) =>
                cited.path === location.path &&
                (cited.startLine === undefined ||
                  (location.startLine !== undefined &&
                    location.endLine !== undefined &&
                    cited.startLine >= location.startLine &&
                    (cited.endLine ?? cited.startLine) <= location.endLine)),
            )
          )
            fail("Evidence location was not inspected by the referenced tool call.");
        }
        const choice = recommendation.choice;
        const localSupport = recommendation.evidence.items.some(
          (item) =>
            !("kind" in item) &&
            item.basis !== "assumed" &&
            hasLocalInspection(this.evidence.get(item.source), item.location),
        );
        const commands = commandOptions(recommendation);
        if (commands.some((option) => option.availability?.status === "available") && !localSupport)
          fail(
            "Command suitability requires inspected local prerequisite evidence, not its prompt body alone.",
          );
        if (POSITIVE_ADVISORY_CHOICES.includes(choice.kind) && !localSupport)
          fail(
            "Positive automation recommendations require inspected local workflow evidence, not assumptions, metadata or external examples alone.",
          );
        if (choice.kind === "generate-from-reference") {
          const { generator } = choice;
          const family = this.families.get(generator.familyId);
          if (!family)
            fail(
              "Generation needs a family detected by the host setup inspection in this turn; for a too-small or undetected group, use needs-more-evidence or another choice.",
            );
          else if (generator.members.some((member) => !family.has(member)))
            fail(
              "Every generator member must belong to the cited detected family; do not mix items from different groups.",
            );
          if (
            generator.reference.kind === "existing-member" &&
            !inspectedWithin(this.evidence.list(), generator.reference.path)
          )
            fail(
              "An existing reference member must be inspected in this turn; otherwise propose building one by hand first.",
            );
        }
        if (choice.kind === "extend-command" && choice.availability.status !== "available")
          fail(
            "Extension requires an inspected base; use needs-more-evidence for an unresolved or unreadable command.",
          );
        for (const option of commands) {
          if (option.availability?.status !== "available") continue;
          if (!this.snapshots.has(fingerprint(option.availability.snapshot)))
            fail(
              "Resolve the exact candidate body before asserting availability; host hashes cannot be supplied by the model.",
            );
        }
      }
      if (failures.length === 1) throw new Error(failures[0]);
      if (failures.length)
        throw new Error(
          `Fix all ${failures.length} problems below, then resubmit once:\n${failures
            .map((line, index) => `${index + 1}. ${line}`)
            .join("\n")}`,
        );
      // Freshness findings stay local until acceptance so a rejected or aborted
      // attempt cannot leave limitations behind for the next one.
      const limitations = new Set(this.limitations);
      for (const [offset, page] of this.pages) {
        try {
          if (fingerprint(await checks.page(offset)) !== page.hash)
            limitations.add(ADVISORY_LIMITATIONS.catalogChangedLate);
        } catch {
          limitations.add(ADVISORY_LIMITATIONS.catalogRecheckFailed);
        }
        checks.signal.throwIfAborted();
      }
      if (!this.fullCoverage()) limitations.add(ADVISORY_LIMITATIONS.catalogIncomplete);
      if (!this.evidence.list().some((receipt) => hasLocalInspection(receipt)))
        limitations.add(ADVISORY_LIMITATIONS.noProjectFiles);
      // One delivery/freshness boundary for selected targets and concrete alternatives.
      // Receipt provenance does not prove the model's explanation of prerequisite relevance.
      for (const recommendation of result.recommendations) {
        for (const option of commandOptions(recommendation)) {
          if (option.availability?.status !== "available") continue;
          const snapshot = option.availability.snapshot;
          const current = await checks.snapshot(snapshot).catch(() => false);
          checks.signal.throwIfAborted();
          if (!current) {
            option.availability = {
              status: "unavailable",
              command: snapshot.command,
              reason: "Command identity/body changed or cannot be safely resolved at submission.",
            };
            limitations.add(ADVISORY_LIMITATIONS.commandChanged);
          }
        }
      }
      checks.signal.throwIfAborted();
      if (this.closed) throw new Error("Advisory scope has ended.");
      const reported = structuredClone(result.coverage);
      if (result.coverage.status === "limited" && !limitations.size)
        limitations.add(ADVISORY_LIMITATIONS.modelLimited);
      result.coverage = this.hostCoverage(limitations);
      if (JSON.stringify(result).length > ADVISORY_LIMITS.resultChars)
        throw new Error(
          "Validated advisory result exceeds 64,000 characters including host limitations.",
        );
      for (const line of limitations) this.limitations.add(line);
      this.accepted = structuredClone(result);
      this.reportedCoverage = reported;
      this.submitted = true;
      return renderAdvisoryResult(result);
    } finally {
      this.submissionPending = false;
    }
  }
}

// Plain wording for the chat report and stored limitations. This is the single
// backend owner; the app shows these strings as they are. TOOL_LABELS and the
// sentence shape must stay in sync with plainLimitation() in
// gg-app/src/programmatic-presentation.ts, which rewords older saved sessions.

const TOOL_LABELS: Readonly<Record<string, string>> = {
  programmatic_scan: "Running your project checks",
  programmatic_advisory_result: "Saving the answer",
  programmatic_profile: "Reading your check setup",
  command_information: "Reading your commands",
  research_corpus: "Searching code examples",
  web_fetch: "Opening a web page",
  web_search: "Searching the web",
  read: "Reading project files",
  find: "Reading project files",
  grep: "Reading project files",
  ls: "Reading project files",
  code_search: "Reading project files",
  code_nav: "Reading project files",
};
const toolLabel = (name: string) => TOOL_LABELS[name] ?? "One of AI's checks";

/** A tool failure or stop, in words a non-specialist understands. Never names the tool. */
export function plainToolLimitation(toolName: string, cancelled: boolean): string {
  return `${toolLabel(toolName)} ${cancelled ? "was stopped" : "failed"}, so this search may have missed something.`;
}

/** Every other host limitation line, so none leaks a tool name, ID or budget term. */
export const ADVISORY_LIMITATIONS = {
  pendingBudget: "AI read more than it could keep track of, so some of what it found wasn't used.",
  delivery: (capped: boolean) =>
    capped
      ? "Something AI read was too long to read in full, so it may have missed part of it."
      : "Something AI tried to read didn't load, so it may have missed something.",
  scanUnavailable: "Your project checks couldn't run in this search, so none were run.",
  scanFailed:
    "Your project checks failed, so these ideas are based only on what AI read itself. Check results show the error.",
  scanSavedBeforeStop:
    "Your project checks saved their results before they were stopped. Reload check results before running them again.",
  catalogBudget: "Your command list was too long to read in full, so AI may have missed a command.",
  bodyBudget: "AI could only open some of your commands, so it may have missed one.",
  catalogChanged:
    "Your commands changed while AI was reading them, so its list may be out of date.",
  catalogChangedLate: "Your commands changed before AI finished, so its list may be out of date.",
  catalogRecheckFailed:
    "AI couldn't recheck your commands at the end, so it isn't sure they all still exist.",
  catalogIncomplete: "AI didn't read your whole command list.",
  catalogPagePartial: "Part of your command list didn't load, so AI may have missed a command.",
  catalogUnavailable:
    "AI can't see your command list here, so it can't tell which commands you already have.",
  commandsUnsupported: "AI couldn't fully read some of your commands.",
  appCommandsUnjudged: "AI can't look inside app-run commands, so it didn't judge what they do.",
  commandUnreadable: "AI couldn't open one of your commands.",
  commandsUnreadable: "AI couldn't read your command list.",
  commandChanged:
    "A command AI suggested changed before it finished, so AI couldn't confirm it still fits.",
  noProjectFiles: "AI didn't read any of your project's own files, so these ideas may miss things.",
  nonText: (toolName: string) =>
    `${toolLabel(toolName)} returned something that isn't text, so AI didn't use it.`,
  unusable: (toolName: string) => `${toolLabel(toolName)} didn't return anything AI could use.`,
  webSourceUnknown: "AI couldn't tell where a web page came from, so it didn't use it as a source.",
  webSourceUnconfirmed:
    "AI couldn't confirm a web page's address, so it didn't credit it as a source.",
  examplesUnavailable:
    "The code-example search isn't set up, so AI didn't compare your project with outside examples. Nothing was installed.",
  modelLimited:
    "AI said it couldn't check everything it wanted to, so it may have missed something.",
  hostFacts: (toolName: string) =>
    `${toolLabel(toolName)} didn't return readable results, so AI worked without them. Nothing was retried.`,
} as const;

/** Shown in chat when the idea search ends without a saved answer. */
export const INCOMPLETE_ADVISORY_NOTICE =
  "## What AI found: no answer this time\n\nThe idea search stopped before it finished, so there are no suggestions yet. Nothing was changed. Any check results you already had are unchanged.";

type Recommendation = Assessment["recommendations"][number];

const BASIS_WORDS = {
  observed: "checked",
  inferred: "best guess",
  assumed: "assumed",
} as const satisfies Record<Recommendation["workflow"]["repeatability"]["basis"], string>;

/** Ideas where the next step is the user's decision; the rest need nothing from them. */
const NEEDS_YOUR_CALL: ReadonlySet<Recommendation["choice"]["kind"]> = new Set([
  "missing-capability",
  "extend-command",
  "generate-from-reference",
]);

type CommandAvailability = Extract<
  Recommendation["choice"],
  { kind: "reuse-command" }
>["availability"];
const commandName = (availability: CommandAvailability) =>
  availability.status === "available"
    ? availability.snapshot.command.name
    : availability.command.name;

function yourPart(recommendation: Recommendation): string {
  const { choice } = recommendation;
  switch (choice.kind) {
    case "reuse-command":
      return choice.availability.status === "available"
        ? `Nothing. /${commandName(choice.availability)} already covers this.`
        : `Check /${commandName(choice.availability)} again. AI couldn't confirm it still works here.`;
    case "manual":
      return "Nothing to set up. Keep doing this yourself; it isn't worth automating.";
    case "needs-more-evidence":
      return "Optional. Look into it if it matters to you.";
    case "missing-capability":
      return "Your call. Review the idea if you want this command made.";
    case "extend-command":
      return `Your call. Review the suggested changes to /${commandName(choice.availability)}.`;
    case "generate-from-reference":
      return "Your call. Review the plan for building it.";
  }
}

const list = (items: readonly string[]) => items.join("; ");
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function headline(result: Assessment): string {
  const total = result.recommendations.length;
  if (!total) return "## What AI found: nothing worth automating right now";
  const calls = result.recommendations.filter((item) =>
    NEEDS_YOUR_CALL.has(item.choice.kind),
  ).length;
  return `## What AI found: ${plural(total, "idea", "ideas")}, ${
    calls ? `${calls} ${calls === 1 ? "needs" : "need"} your call` : "nothing you need to do"
  }`;
}

function choiceLines(recommendation: Recommendation): string[] {
  const { choice } = recommendation;
  switch (choice.kind) {
    case "manual":
      return [`Steps to do it yourself: ${list(choice.steps)}`];
    case "needs-more-evidence":
      return [
        `What's missing: ${list(choice.missingEvidence)}`,
        `What to check next: ${list(choice.nextInspectionSteps)}`,
      ];
    case "missing-capability":
    case "extend-command": {
      const proposal = choice.kind === "missing-capability" ? choice.proposal : choice.requirement;
      return [
        `${choice.kind === "extend-command" ? "What the changed command would do" : "What the new command would do"}: ${proposal.desiredOutcome}`,
        ...(choice.kind === "extend-command"
          ? [`Suggested changes: ${list(choice.proposedChanges)}`]
          : []),
        `Uses: ${list(proposal.inputs)}`,
        `Produces: ${list(proposal.outputs)}`,
        `Needs: ${list(proposal.prerequisites)}`,
        `Risks: ${list(proposal.risks)}`,
        `How to tell it works: ${list(proposal.verificationExpectations)}`,
        ...(proposal.capabilityKind === "app-backed"
          ? ["This needs a change to the GG app itself. A command alone can't do it."]
          : []),
      ];
    }
    case "generate-from-reference": {
      const { generator } = choice;
      return [
        `Plan: get one example right, then copy it for the other ${plural(generator.members.length - 1, "similar item", "similar items")}.`,
        generator.reference.kind === "existing-member"
          ? `Example to copy: ${generator.reference.path}: ${generator.reference.reason} (looked at, not tested)`
          : `Example to copy: build one yourself first. ${generator.reference.reason}`,
        `Items: ${list(generator.members)}`,
        `Same in each: ${list(generator.sharedShape)}`,
        `Different in each: ${list(generator.varyingInputs)}`,
        `Risks: ${list(generator.risks)}`,
        `How to tell it works: ${list(generator.verificationExpectations)}`,
      ];
    }
    case "reuse-command":
      return [];
  }
}

function commandLines(recommendation: Recommendation): string[] {
  const { choice } = recommendation;
  if (choice.kind !== "reuse-command" && choice.kind !== "extend-command") return [];
  const availability = choice.availability;
  if (availability.status !== "available")
    return [`/${availability.command.name} couldn't be found: ${availability.reason}`];
  return [
    `/${availability.snapshot.command.name} exists. It hasn't been run, and AI hasn't confirmed it does everything needed.`,
    ...(availability.snapshot.capabilityKind === "app-backed"
      ? ["It needs a GG app feature to run, so it can't run from this chat."]
      : []),
  ];
}

/** Short chat summary; the full report stays in the tool result and Opportunities. */
export function renderAdvisorySummary(
  result: Assessment,
  limitations: readonly string[],
  detailsInOpportunities = false,
): string {
  const lines = [
    headline(result),
    "Suggestions only. Nothing runs or changes without your OK.",
    `Looked at: ${result.coverage.scope}`,
  ];
  const [first] = limitations;
  if (result.coverage.status === "limited" && first)
    lines.push(
      `Didn't fully check: ${first}${
        limitations.length > 1 ? ` And ${count(limitations.length - 1, "more limit")}.` : ""
      }`,
    );
  if (!result.recommendations.length)
    lines.push("AI found nothing worth automating in the parts it looked at.");
  else if (detailsInOpportunities) lines.push("Full details are in Opportunities.");
  return safeText(lines.join("\n"));
}

/** Plain transcript content, never opportunities, run controls or approval objects. */
export function renderAdvisoryResult(result: Assessment): string {
  const lines = [
    headline(result),
    "Suggestions only. Nothing runs or changes without your OK.",
    `Looked at: ${result.coverage.scope}`,
  ];
  if (result.coverage.status === "limited")
    lines.push(`Didn't fully check: ${result.coverage.reason}`);
  if (!result.recommendations.length)
    lines.push("AI found nothing worth automating in the parts it looked at.");
  for (const [index, recommendation] of result.recommendations.entries()) {
    const { workflow } = recommendation;
    lines.push(
      `\n${index + 1}. ${recommendation.outcome}`,
      `Why it helps: ${recommendation.rationale}`,
      `Your part: ${yourPart(recommendation)}`,
      `Not sure about: ${recommendation.uncertainty}`,
      `Where: ${workflow.affectedSubproject.scope === "repository-wide" ? "whole project" : workflow.affectedSubproject.path}`,
      `What would change: ${workflow.mutationBoundary}`,
      ...choiceLines(recommendation),
      ...commandLines(recommendation),
    );
    for (const item of recommendation.evidence.items) {
      if (!("kind" in item) && item.severity !== "info")
        lines.push(`Heads-up (${BASIS_WORDS[item.basis]}): ${item.message}`);
    }
    // Keep known restrictions, not a routine report of unselected alternatives.
    for (const alternative of recommendation.alternatives) {
      if (alternative.availability?.status === "unavailable")
        lines.push(
          `/${alternative.availability.command.name} couldn't be found: ${alternative.availability.reason}`,
        );
    }
  }
  return safeText(lines.join("\n"));
}
