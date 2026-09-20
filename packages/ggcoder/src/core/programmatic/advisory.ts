import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import { safeRetrievalUrl, type InspectedLocalLocation, type RetrievalResource } from "../../tools/retrieval-metadata.js";
import type { AdvisoryCommandPage } from "../command-discovery.js";
import { ProgrammaticSetupInspection, SETUP_ASSESSMENT_TOOLS } from "./setup-inspection.js";
import {
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
export function deliveredExternalReceipt(receipts: AdvisoryReceipt[], citation: {
  inspectedUrl: string; revision?: string; location?: { path: string; startLine?: number; endLine?: number };
}): AdvisoryReceipt | undefined {
  return receipts.find((receipt) => receipt.status === "retrieved" &&
    receipt.external?.sourceUri === citation.inspectedUrl &&
    (!citation.revision || receipt.external.revision === citation.revision) &&
    (!citation.location || (receipt.external.path === citation.location.path &&
      citation.location.startLine === undefined && citation.location.endLine === undefined)));
}

export function localLocations(receipt: AdvisoryReceipt | undefined): { path: string; startLine?: number; endLine?: number }[] {
  if (receipt?.status !== "retrieved") return [];
  return receipt.locations ?? (receipt.location ? [{ path: receipt.location, ...receipt.range }] : []);
}

function hasLocalInspection(receipt: AdvisoryReceipt | undefined, cited?: { path: string }): boolean {
  return localLocations(receipt).some((location) =>
    (!cited || location.path === cited.path) &&
    receipt?.localSources?.some((source) => source.path === location.path && source.purpose === "independent"));
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
  readonly mode: "setup" | "configured";
  private readonly setup?: ProgrammaticSetupInspection;
  private accepted?: Assessment;
  get acceptedResult(): Assessment | undefined { return this.accepted && structuredClone(this.accepted); }
  get deterministicState(): ScanState { return this.scanState; }
  allows(tool: string): boolean {
    return this.active && (this.mode === "setup" ? SETUP_ASSESSMENT_TOOLS.has(tool) : ADVISORY_READ_TOOLS.has(tool));
  }
  constructor(readonly evidence: AdvisoryEvidence, policy: ProgrammaticAdvisoryPolicy = { mode: "configured" }) {
    this.mode = policy.mode;
    if (this.mode === "setup") this.setup = new ProgrammaticSetupInspection(true);
    else if (policy.scanAvailable === false) this.markScanUnavailable();
  }
  /** Host policy boundary, before a claim only. Never converts denial/failure into a retry. */
  markScanUnavailable(): void {
    if (this.active && this.mode === "configured" && this.scanState === "not-started") {
      this.scanState = "unavailable";
      this.limitations.add("The deterministic scan tool is unavailable under host policy; no scan was attempted.");
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
    if (!this.allows(tool))
      throw new Error("Tool unavailable in read-only advisory scope.");
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
    checks.signal.throwIfAborted();
    if (this.submitted || this.submissionPending)
      throw new Error("Only one validated advisory presentation is permitted per turn.");
    if (this.mode === "configured" && (this.scanState === "not-started" || this.scanState === "in-flight"))
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
      const result = programmaticAssessmentResultV2Schema.parse(input);
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
        !this.evidence.list().some((receipt) => hasLocalInspection(receipt))
      )
        this.limitations.add("Bounded local source evidence was not inspected.");
      for (const recommendation of result.recommendations) {
        for (const item of recommendation.evidence.items) {
          if ("kind" in item) {
            if (
              !deliveredExternalReceipt(this.evidence.list(), item)
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
        const localSupport = recommendation.evidence.items.some((item) =>
          !("kind" in item) && item.basis !== "assumed" &&
          hasLocalInspection(this.evidence.get(item.source), item.location));
        const commands = [
          ...(choice.kind === "reuse-command" || choice.kind === "extend-command" ? [choice] : []),
          ...recommendation.alternatives.filter((option) => option.availability !== undefined),
        ];
        if (commands.some((option) => option.availability?.status === "available") && !localSupport)
          throw new Error("Command suitability requires inspected local prerequisite evidence, not its prompt body alone.");
        if (["reuse-command", "extend-command", "missing-capability"].includes(choice.kind) && !localSupport)
          throw new Error("Positive automation recommendations require inspected local workflow evidence, not assumptions, metadata or external examples alone.");
        if (choice.kind === "extend-command" && choice.availability.status !== "available")
          throw new Error("Extension requires an inspected base; use needs-more-evidence for an unresolved or unreadable command.");
        // One delivery/freshness boundary for selected targets and concrete alternatives.
        // Receipt provenance does not prove the model's explanation of prerequisite relevance.
        for (const option of commands) {
          if (option.availability?.status !== "available") continue;
          const snapshot = option.availability.snapshot;
          if (!this.snapshots.has(fingerprint(snapshot)))
            throw new Error("Resolve the exact candidate body before asserting availability; host hashes cannot be supplied by the model.");
          const current = await checks.snapshot(snapshot).catch(() => false);
          checks.signal.throwIfAborted();
          if (!current) {
            option.availability = {
              status: "unavailable", command: snapshot.command,
              reason: "Command identity/body changed or cannot be safely resolved at submission.",
            };
            this.limitations.add("A recommended or compared command changed before submission.");
          }
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
      this.accepted = structuredClone(result);
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
    "Advice only. Running or editing anything requires separate approval.",
    `Checked: ${result.coverage.scope}`,
  ];
  if (result.coverage.status === "limited") lines.push(`Limits: ${result.coverage.reason}`);
  if (!result.recommendations.length)
    lines.push("No supported recommendation was found in the inspected scope.");
  for (const [index, recommendation] of result.recommendations.entries()) {
    const { workflow, choice } = recommendation;
    lines.push(
      `\n${index + 1}. ${recommendation.outcome}`,
      `Why: ${recommendation.rationale}`,
      `Uncertainty: ${recommendation.uncertainty}`,
      `Scope: ${workflow.affectedSubproject.scope === "repository-wide" ? "repository-wide" : workflow.affectedSubproject.path}`,
      `Proposed change boundary: ${workflow.mutationBoundary}`,
    );
    if (choice.kind === "manual") lines.push(`Next: follow these manual steps — ${choice.steps.join("; ")}`);
    else if (choice.kind === "needs-more-evidence") lines.push(
      `Missing evidence: ${choice.missingEvidence.join("; ")}`,
      `Next: inspect without making changes — ${choice.nextInspectionSteps.join("; ")}`,
    );
    if (choice.kind === "missing-capability" || choice.kind === "extend-command") {
      const proposal = choice.kind === "missing-capability" ? choice.proposal : choice.requirement;
      lines.push(`Proposal only: ${proposal.desiredOutcome}`);
      if (choice.kind === "extend-command") lines.push(`Proposed changes: ${choice.proposedChanges.join("; ")}`);
      lines.push(
        `Inputs: ${proposal.inputs.join("; ")}`,
        `Outputs: ${proposal.outputs.join("; ")}`,
        `Prerequisites: ${proposal.prerequisites.join("; ")}`,
        `Risks: ${proposal.risks.join("; ")}`,
        `Verification needed: ${proposal.verificationExpectations.join("; ")}`,
        proposal.capabilityKind === "app-backed"
          ? "Next: plan application development. A prompt alone cannot provide this functionality."
          : choice.kind === "extend-command"
            ? "Next: review the base command and proposed changes. Editing requires separate approval."
            : "Next: review the proposal before creating a command; verify it before running it.",
      );
    }
    if (choice.kind === "reuse-command" || choice.kind === "extend-command") {
      const availability = choice.availability;
      lines.push(availability.status === "available"
        ? `/${availability.snapshot.command.name}: ${availability.snapshot.command.invocationKind === "workspace-action" ? "workspace action" : "prompt"} available, not started. This does not guarantee the required tools or behavior.`
        : `/${availability.command.name} unavailable: ${availability.reason}`);
      if (availability.status === "unavailable")
        lines.push("Next: recheck the command and project prerequisites before proceeding.");
      else if (availability.snapshot.capabilityKind === "app-backed")
        lines.push("Next: review the required application integration. This proposal cannot run it.");
      else if (choice.kind === "reuse-command")
        lines.push("Next: review the current command, prerequisites and scope before approving a run.");
    }
    for (const item of recommendation.evidence.items) {
      if (!("kind" in item) && item.severity !== "info")
        lines.push(`Reported limit (${item.basis}): ${item.message}`);
    }
    // Keep known restrictions, not a routine report of unselected alternatives.
    for (const alternative of recommendation.alternatives) {
      if (alternative.availability?.status === "unavailable")
        lines.push(`/${alternative.availability.command.name} unavailable: ${alternative.availability.reason}`);
    }
  }
  return safeText(lines.join("\n"));
}
