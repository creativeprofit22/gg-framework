import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import { safeRetrievalUrl, type InspectedLocalLocation, type RetrievalResource } from "../../tools/retrieval-metadata.js";
import type { AdvisoryCommandPage } from "../command-discovery.js";
import {
  programmaticAssessmentResultV1Schema,
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
type Assessment = z.infer<typeof programmaticAssessmentResultV1Schema>;
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
  location?: string;
  range?: { startLine: number; endLine: number };
  external?: External;
  /** Complete local source chunks delivered by the host; never parsed from headers. */
  locations?: InspectedLocalLocation[];
}

function localLocations(receipt: AdvisoryReceipt | undefined): { path: string; startLine?: number; endLine?: number }[] {
  if (receipt?.status !== "retrieved") return [];
  return receipt.locations ?? (receipt.location ? [{ path: receipt.location, ...receipt.range }] : []);
}

function hasLocalInspection(receipt: AdvisoryReceipt | undefined): boolean {
  return localLocations(receipt).length > 0;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const locations = tool === "code_search" && retrieval?.outcome === "retrieved"
      ? (retrieval.localLocations ?? []).slice(0, 64).filter((location) => repositoryRelativePathSchema.safeParse(location.path).success)
      : [];
    // LSP outlines, references, definitions and hover are navigation leads,
    // not whole inspected source, even when the tool reads files internally.
    const inspected =
      tool === "read" || locations.length > 0 ||
      tool === "web_fetch" ||
      (tool === "research_corpus" && input.action === "show");
    const receipt: AdvisoryReceipt = {
      id: `receipt-${randomUUID()}`,
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
type ScanState = "not-started" | "in-flight" | ScanSettlement;

/** Turn-local bookkeeping only. Semantic assessment remains in the existing model loop. */
export class ProgrammaticAdvisoryTurn {
  readonly limitations = new Set<string>();
  private readonly pages = new Map<number, { hash: string; next: number | null; total: number }>();
  private readonly snapshots = new Map<string, ProgrammaticCommandSnapshotV1>();
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
      this.limitations.add("Pending evidence delivery budget reached.");
      return;
    }
    this.pendingResults.set(toolCallId, accept);
  }
  resultPrepared(result: Readonly<ToolResult>): void {
    const accept = this.pendingResults.get(result.toolCallId);
    if (!this.active || !accept) return;
    this.pendingResults.delete(result.toolCallId);
    const complete = !result.capped && !result.isError;
    if (!complete)
      this.limitations.add(`Tool call ${result.toolCallId.slice(0, 128)}: source delivery was ${result.capped ? "capped" : "unsuccessful"}; complete inspection is not established.`);
    accept(complete);
  }
  constructor(readonly evidence: AdvisoryEvidence) {}
  get active(): boolean {
    return !this.closed;
  }
  close(): void {
    if (this.scanState === "in-flight") this.settleScan("cancelled");
    this.closed = true;
    for (const cleanup of this.executionCleanups) cleanup();
    this.executionCleanups.clear();
    this.pages.clear();
    this.snapshots.clear();
    this.pendingResults.clear();
  }
  claim(tool: string, args: unknown): void {
    if (this.closed || !ADVISORY_READ_TOOLS.has(tool))
      throw new Error("Tool unavailable in read-only advisory scope.");
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
        this.limitations.add("Catalog page/metadata budget reached.");
        throw new Error("Advisory catalog budget reached; report limited coverage.");
      }
    } else if (input.action === "resolve" && ++this.bodyCalls > ADVISORY_LIMITS.bodies) {
      this.limitations.add("Candidate body budget reached.");
      throw new Error("Advisory candidate budget reached; report limited coverage.");
    }
  }
  /** Host execution boundary only; model result fields cannot settle the scan. */
  settleScan(outcome: ScanSettlement): void {
    if (this.closed || this.scanState !== "in-flight") return;
    this.scanState = outcome;
    if (outcome === "failed")
      this.limitations.add(
        "The deterministic scan failed; its separate error remains authoritative. Advice is limited to independently inspected evidence, not scanner results.",
      );
  }
  observePage(page: AdvisoryCommandPage): void {
    const serialized = JSON.stringify(page);
    this.metadataChars += serialized.length;
    if (this.metadataChars >= ADVISORY_LIMITS.metadataChars)
      this.limitations.add("Metadata budget reached.");
    const hash = fingerprint(page);
    if (this.pages.has(page.offset) && this.pages.get(page.offset)!.hash !== hash)
      this.limitations.add("Catalog changed during assessment.");
    if (page.entries.some((entry) => entry.metadataLimited || entry.bodyUnavailableReason))
      this.limitations.add("Some command metadata or identities are unsupported.");
    this.pages.set(page.offset, { hash, next: page.nextOffset, total: page.total });
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
              ? "Workspace action capabilities remain unassessed."
              : "A candidate body was unavailable or unreadable.",
          );
      }
    } catch {
      this.limitations.add("Command information could not be inspected.");
    }
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
    if (this.submitted || this.submissionPending)
      throw new Error("Only one validated advisory presentation is permitted per turn.");
    if (this.scanState === "not-started" || this.scanState === "in-flight")
      throw new Error(
        "The required deterministic scan attempt must settle before advisory submission.",
      );
    if (this.scanState === "denied" || this.scanState === "cancelled")
      throw new Error(
        "The deterministic scan was denied or cancelled; advisory submission is unavailable. Do not retry the scan or repair setup in this turn.",
      );
    if (this.pendingResults.size)
      throw new Error("Evidence results are awaiting post-cap preparation; submit in a later model turn.");
    this.submissionPending = true;
    try {
      if (JSON.stringify(input).length > ADVISORY_LIMITS.resultChars)
        throw new Error("Advisory result exceeds 64,000 characters.");
      const result = programmaticAssessmentResultV1Schema.parse(input);
      if (result.recommendations.length > ADVISORY_LIMITS.recommendations)
        throw new Error("At most 10 advisory recommendations are permitted.");
      for (const [offset, page] of this.pages) {
        try {
          if (fingerprint(await checks.page(offset)) !== page.hash)
            this.limitations.add("Catalog changed before submission.");
        } catch {
          this.limitations.add(
            "Current catalog could not be rechecked; availability remains uncertain.",
          );
        }
        checks.signal.throwIfAborted();
      }
      if (!this.fullCoverage())
        this.limitations.add("Not all current catalog pages were inspected.");
      if (
        !this.evidence.list().some(hasLocalInspection)
      )
        this.limitations.add("Bounded local source evidence was not inspected.");
      for (const recommendation of result.recommendations) {
        for (const item of recommendation.evidence.items) {
          if ("kind" in item) {
            if (
              !this.evidence
                .list()
                .some(
                  (receipt) =>
                    receipt.status === "retrieved" &&
                    receipt.external?.sourceUri === item.inspectedUrl &&
                    (!item.revision || receipt.external.revision === item.revision) &&
                    (!item.location || (receipt.external.path === item.location.path && item.location.startLine === undefined)),
                )
            )
              throw new Error(
                "External provenance must match an inspected host receipt; search leads and unsupplied revisions are not evidence.",
              );
            continue;
          }
          if (item.basis === "assumed" && item.source === "assumption") continue;
          const receipt = this.evidence.get(item.source);
          if (!receipt)
            throw new Error(
              "Evidence source must reference a retained host receipt ID (or an explicit assumption).",
            );
          if (item.basis === "observed" && receipt.status !== "retrieved")
            throw new Error("Search leads and failed calls cannot substantiate observed evidence.");
          const cited = item.location;
          if (cited && !localLocations(receipt).some((location) =>
            cited.path === location.path && (cited.startLine === undefined ||
              (location.startLine !== undefined && location.endLine !== undefined &&
                cited.startLine >= location.startLine && (cited.endLine ?? cited.startLine) <= location.endLine))))
            throw new Error("Evidence location was not inspected by the referenced tool call.");
        }
        const choice = recommendation.choice;
        if (choice.kind === "reuse-command" && choice.availability.status === "available") {
          const snapshot = choice.availability.snapshot;
          if (!this.snapshots.has(fingerprint(snapshot)))
            throw new Error(
              "Resolve the exact candidate body before asserting availability; host hashes cannot be supplied by the model.",
            );
          const current = await checks.snapshot(snapshot).catch(() => false);
          checks.signal.throwIfAborted();
          if (!current) {
            choice.availability = {
              status: "unavailable",
              command: snapshot.command,
              reason: "Command identity/body changed or cannot be safely resolved at submission.",
            };
            this.limitations.add("A recommended command changed before submission.");
          }
          if (
            !recommendation.evidence.items.some(
              (item) =>
                !("kind" in item) &&
                item.basis !== "assumed" &&
                hasLocalInspection(this.evidence.get(item.source)),
            )
          )
            throw new Error(
              "Command suitability requires inspected local prerequisite evidence, not its prompt body alone.",
            );
        }
      }
      checks.signal.throwIfAborted();
      if (this.closed) throw new Error("Advisory scope has ended.");
      if (this.limitations.size)
        result.coverage = {
          status: "limited",
          scope: result.coverage.scope,
          reason: [
            result.coverage.status === "limited" ? result.coverage.reason : "",
            ...this.limitations,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 4_000),
        };
      if (JSON.stringify(result).length > ADVISORY_LIMITS.resultChars)
        throw new Error(
          "Validated advisory result exceeds 64,000 characters including host limitations.",
        );
      this.submitted = true;
      return renderAdvisoryResult(result);
    } finally {
      this.submissionPending = false;
    }
  }
}

/** Plain transcript content, never opportunities, run controls or approval objects. */
export function renderAdvisoryResult(result: Assessment): string {
  const lines = [
    "## Recommendations — not started",
    "Advice only: availability and suitability do not authorize execution.",
    "Retrieval provenance does not verify claims; external URLs are source attribution, not proof of live URL fetching.",
    `Coverage: ${result.coverage.status} — ${result.coverage.scope}${result.coverage.status === "limited" ? `. ${result.coverage.reason}` : ""}`,
  ];
  if (!result.recommendations.length)
    lines.push("No supported recommendation from this bounded assessment.");
  for (const [index, recommendation] of result.recommendations.entries()) {
    lines.push(
      `\n${index + 1}. ${recommendation.outcome}`,
      `Why: ${recommendation.rationale}`,
      `Uncertainty: ${recommendation.uncertainty}`,
    );
    const choice = recommendation.choice;
    if (choice.kind === "manual") lines.push(`Manual alternative: ${choice.steps.join("; ")}`);
    else if (choice.kind === "missing-capability") {
      const proposal = choice.proposal;
      lines.push(
        `Missing ${proposal.capabilityKind} capability — proposal only: ${proposal.desiredOutcome}`,
        `Inputs: ${proposal.inputs.join("; ")}`,
        `Outputs: ${proposal.outputs.join("; ")}`,
        `Prerequisites: ${proposal.prerequisites.join("; ")}`,
        `Risks: ${proposal.risks.join("; ")}`,
        `Verification needed: ${proposal.verificationExpectations.join("; ")}`,
      );
    } else
      lines.push(
        choice.availability.status === "available"
          ? `Reuse /${choice.availability.snapshot.command.name} — prompt available, not started; prompt identity is not a host capability guarantee.`
          : `Command unavailable /${choice.availability.command.name}: ${choice.availability.reason}`,
      );
    for (const item of recommendation.evidence.items) {
      const location = item.location;
      const details = location ? [`path: ${location.path}`] : [];
      if (location?.startLine !== undefined)
        details.push(
          location.endLine !== undefined
            ? `lines: ${location.startLine}-${location.endLine}`
            : `line: ${location.startLine}`,
        );
      if ("kind" in item && item.revision !== undefined)
        details.push(`revision: ${item.revision}`);
      const suffix = details.length ? `, ${details.join(", ")}` : "";
      lines.push(
        "kind" in item
          ? `External evidence (${item.basis}, ${item.inspectedUrl}${suffix}): ${item.claim}`
          : `Evidence (${item.basis}, ${item.source}${suffix}): ${item.message}`,
      );
    }
  }
  return safeText(lines.join("\n"));
}
