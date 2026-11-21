import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolExecuteResult } from "@kenkaiiii/gg-agent";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import { discoverCommands, type CommandDiscoveryOptions } from "../command-discovery.js";
import { appendCommandArguments } from "../custom-commands.js";
import { canonicalRepositoryRoot, containedPath, sha256, stableJson } from "../tauri-package/paths.js";
import { commandEnvironmentSha256, commandLocalStat, readCommandText, type InspectedCommandProposal } from "./command-creation.js";
import { programmaticCommandVerificationStateSchema, programmaticVerificationV1Schema, repositoryRelativePathSchema, type ProgrammaticCommandVerificationState } from "./contracts.js";
import { checkReferenceReproduction, enumerateReference, evaluateGeneratorVerification, FAMILY_GENERATOR_LIMITS, type FamilyFileAccess, type FamilyGeneratorMetadata, type GeneratorVerification } from "./family-generator.js";
import { detectLanguages } from "../language-detector.js";
import { detectVerifyCommands } from "../verify-commands.js";

const familyIo: FamilyFileAccess = { stat: commandLocalStat, readText: readCommandText };

const caseSchema = z.strictObject({ category: z.enum(["behavior", "side-effects"]),
  scenario: z.enum(["normal", "incomplete", "out-of-scope"]), input: z.string().min(1).max(4000),
  assertion: z.string().min(1).max(4000) });
export const commandVerificationPlanSchema = z.strictObject({
  command: z.string().min(1).max(8000),
  testFiles: z.array(repositoryRelativePathSchema.refine((file) => !/[:\\]/.test(file) && file.split("/").every((part) =>
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))).min(1).max(32),
  cases: z.array(caseSchema).min(1).max(9),
});
type TestPlan = z.infer<typeof commandVerificationPlanSchema>;
type Digest = { path: string; sha256: string };
/** What a family preview/apply may use: only after a fresh check against the verified generator. */
export type GeneratorForApply =
  | { status: "unavailable"; reason: "unknown-session-proposal" | "generator-not-verified" | "stale-generator-verify-again" }
  | { status: "ready"; generation: number; root: string; metadata: FamilyGeneratorMetadata; helperTexts: Map<string, string>; runtimeExecutable: string;
      binding: { snapshot: InspectedCommandProposal["proposal"]["snapshot"]; files: Digest[]; prerequisites: Digest[]; environmentSha256: string };
      verification: GeneratorVerification };
interface Receipt {
  id: string;
  proposalId: string;
  toolCallId: string;
  tool: "bash";
  input: string;
  command: string;
  files: Digest[];
  tests: Digest[];
  environment: string;
  provider: string;
  model: string;
  cases: TestPlan["cases"];
  outputSha256?: string;
  execution?: { executionId: string; reason: string; exitCode: number | null; cwdSha256: string; outputCapped: boolean };
  prepared: boolean;
  limited: boolean;
  invalidated?: boolean;
}

/** Bounded, ephemeral provenance; neither a subprocess runner nor an output grader. */
export class CommandVerification {
  private proposal?: InspectedCommandProposal;
  private plan?: { value: TestPlan; tests: Digest[] };
  private receipts = new Map<string, Receipt>();
  private inflight = new Map<string, Receipt>();
  private report?: z.infer<typeof programmaticVerificationV1Schema>;
  /** Last passing generator verification and the reviewed file digests it saw. */
  private verified?: { proposalId: string; files: Digest[]; verification: GeneratorVerification };
  /** Single-use family preview awaiting apply approval; never persisted. */
  private pendingPreview?: { handle: string; previewId: string; value: unknown };
  private generation = 0;
  /** `runtimeExecutable` is host-owned (default `process.execPath`), never a tool parameter. */
  constructor(private readonly discovery: CommandDiscoveryOptions & { runtimeExecutable?: string },
    private readonly model: () => { provider: string; model: string } = () => ({ provider: "deterministic", model: "no-model" })) {}
  /** The session owner clears retained evidence on cancellation and transitions. */
  clear(): void { this.generation++; this.proposal = undefined; this.plan = undefined; this.receipts.clear(); this.inflight.clear(); this.report = undefined; this.verified = undefined; this.pendingPreview = undefined; }
  /** True while no clear/transition happened since `generation` was read. */
  isCurrent(generation: number): boolean { return generation === this.generation; }
  setPendingPreview(handle: string, previewId: string, value: unknown): void { this.pendingPreview = { handle, previewId, value }; }
  /** Consumed before any await: a preview approves at most one apply. */
  consumePendingPreview(handle: string, previewId: string): unknown {
    const pending = this.pendingPreview; this.pendingPreview = undefined;
    return pending && pending.handle === handle && pending.previewId === previewId ? pending.value : undefined;
  }
  /** Fresh owner/content/environment check against the last passing generator verification. */
  async generatorForApply(handle: string, signal: AbortSignal): Promise<GeneratorForApply> {
    const proposal = this.proposal; const verified = this.verified;
    if (proposal?.proposal.proposalId !== handle) return { status: "unavailable", reason: "unknown-session-proposal" };
    if (!proposal.generator || !verified || verified.proposalId !== handle) return { status: "unavailable", reason: "generator-not-verified" };
    const generation = this.generation; const family = proposal.generator;
    try {
      const current = await this.current(signal);
      if (generation !== this.generation || signal.aborted || stableJson(current.files) !== stableJson(verified.files)) throw new Error("stale");
      const helperTexts = new Map<string, string>();
      for (const file of proposal.files) if (file.path.startsWith(`${family.helperDirectory}/`)) {
        if (current.files.find((item) => item.path === file.path)?.sha256 !== sha256(file.content)) throw new Error("stale");
        helperTexts.set(file.path.slice(family.helperDirectory.length + 1), file.content);
      }
      return { status: "ready", generation, root: proposal.root, metadata: structuredClone(family), helperTexts, runtimeExecutable: this.runtime(),
        binding: { snapshot: structuredClone(proposal.proposal.snapshot), files: current.files, prerequisites: structuredClone(proposal.prerequisites), environmentSha256: proposal.environmentSha256 },
        verification: structuredClone(verified.verification) };
    } catch { if (signal.aborted) throw signal.reason; return { status: "unavailable", reason: "stale-generator-verify-again" }; }
  }
  created(proposal: InspectedCommandProposal): void {
    this.clear(); this.proposal = structuredClone(proposal);
  }
  private runtime(): string { return this.discovery.runtimeExecutable ?? process.execPath; }
  private environment(): string { return stableJson({ node: process.version, platform: process.platform, arch: process.arch, ...this.model() }); }
  private async digests(files: readonly string[], signal: AbortSignal): Promise<Digest[]> {
    if (!this.proposal) throw new Error("unknown-proposal");
    const root = this.proposal.root;
    return Promise.all(files.map(async (file) => ({ path: file,
      sha256: sha256(await readCommandText(containedPath(root, file), signal)) })));
  }
  private async current(signal: AbortSignal, observation?: ProgrammaticCommandVerificationState): Promise<{ files: Digest[]; prompt: string }> {
    const proposal = this.proposal;
    if (!proposal || signal.aborted) throw new Error("unknown-or-cancelled-proposal");
    if (await canonicalRepositoryRoot(proposal.root) !== proposal.root) throw new Error("owner-changed");
    const stat = await commandLocalStat(proposal.root);
    if (!stat || `${stat.dev}:${stat.ino}` !== proposal.rootIdentity) throw new Error("owner-changed");
    // Resolve loading independently before checking the exact reviewed snapshot.
    const entry = (await discoverCommands(proposal.root, this.discovery)).resolve(proposal.proposal.snapshot.command.name);
    if (signal.aborted || proposal !== this.proposal) throw new Error("cancelled");
    if (!entry) {
      if (observation) observation.loads = false;
      throw new Error("command-not-resolved");
    }
    if (!entry.custom || entry.custom.scope !== "project" || path.resolve(entry.custom.filePath) !== containedPath(proposal.root, proposal.proposal.commandPath))
      throw new Error("command-owner-changed");
    if (observation) observation.loads = true;
    if (await commandEnvironmentSha256(this.runtime()) !== proposal.environmentSha256) throw new Error("environment-changed");
    const prerequisites = await this.digests(proposal.prerequisites.map((file) => file.path), signal);
    if (stableJson(prerequisites) !== stableJson(proposal.prerequisites)) throw new Error("prerequisites-changed");
    // Added or removed reference files are not covered by per-file digests.
    const generator = proposal.generator;
    if (generator && stableJson(await enumerateReference(proposal.root, generator.reference, generator.kind, familyIo, signal)) !== stableJson(generator.referenceFiles))
      throw new Error("reference-changed");
    const files = await this.digests(proposal.files.map((file) => file.path), signal);
    if (files.some((file) => !proposal.proposal.files.some((expected) => expected.path === file.path && expected.proposedSha256 === file.sha256)))
      throw new Error("reviewed-content-changed");
    if (sha256(entry.custom.prompt) !== proposal.proposal.snapshot.bodySha256) throw new Error("reviewed-prompt-changed");
    return { files, prompt: entry.custom.prompt };
  }
  async prepare(handle: string, input: unknown, signal: AbortSignal) {
    this.plan = undefined;
    const value = commandVerificationPlanSchema.parse(input);
    if (this.proposal?.proposal.proposalId !== handle) return { status: "unavailable", reason: "unknown-session-proposal" };
    const generation = this.generation;
    try {
      await this.current(signal);
      const tests = await this.digests(value.testFiles, signal);
      if (generation !== this.generation || signal.aborted) throw new Error("cancelled");
      this.plan = { value: structuredClone(value), tests };
      return { status: "prepared", tests, command: value.command, executionApproved: false,
        limits: ["No test was executed. Use the normal approved nonpersistent foreground bash tool separately.",
          "Persistent bash calls cannot supply project-bound receipts: actual shell cwd and exports are not host-attested.",
          "Requested assertions are claims, not host-established coverage."] };
    } catch { return { status: "unavailable", reason: "stale-or-unreadable-content" }; }
  }
  /** Called only after the guarded tool lifecycle's policy/approval checks. */
  async observeStart(tool: string, args: unknown, context: ToolContext): Promise<string | undefined> {
    const duplicates = [...this.receipts.values(), ...this.inflight.values()].filter((receipt) => receipt.toolCallId === context.toolCallId);
    if (duplicates.length) { for (const receipt of duplicates) { receipt.invalidated = true; receipt.prepared = false; } return; }
    const plan = this.plan;
    const command = z.object({ command: z.string(), run_in_background: z.boolean().optional(), persist: z.boolean().optional() }).safeParse(args);
    // Persistent diagnostics carry launch cwd, not the reused shell's actual cwd
    // or exports. Host-process fingerprints cannot attest that execution state.
    if (!plan || tool !== "bash" || !command.success || command.data.run_in_background || command.data.persist || command.data.command !== plan.value.command) return;
    const generation = this.generation;
    try {
      const current = await this.current(context.signal);
      const tests = await this.digests(plan.value.testFiles, context.signal);
      if (stableJson(tests) !== stableJson(plan.tests) || generation !== this.generation || context.signal.aborted) return;
      const id = randomUUID();
      const input = stableJson(args);
      if (input.length > 16_000) return;
      this.inflight.set(id, { id, proposalId: this.proposal!.proposal.proposalId, toolCallId: context.toolCallId,
        tool: "bash", input, command: command.data.command, files: current.files, tests, environment: this.environment(), ...this.model(),
        cases: structuredClone(plan.value.cases), prepared: false, limited: true });
      while (this.inflight.size > 64) this.inflight.delete(this.inflight.keys().next().value!);
      return id;
    } catch { return; }
  }
  async observeEnd(id: string | undefined, output: ToolExecuteResult | undefined, signal: AbortSignal): Promise<void> {
    if (!id) return;
    const receipt = this.inflight.get(id); this.inflight.delete(id);
    if (!receipt || signal.aborted || output === undefined) return;
    const generation = this.generation;
    const structured = z.object({ content: z.string(), details: z.unknown().optional() }).safeParse(output);
    receipt.outputSha256 = sha256(typeof output === "string" ? output : structured.success ? structured.data.content : stableJson(output));
    if (structured.success) {
      const diagnostics = z.object({ bashDiagnostics: z.object({ executionId: z.string().max(128), reason: z.string().max(64),
        exitCode: z.number().int().nullable(), cwd: z.string().max(4000), outputCapped: z.boolean() }) }).safeParse(structured.data.details);
      if (diagnostics.success) {
        const { cwd, ...execution } = diagnostics.data.bashDiagnostics;
        receipt.execution = { ...execution, cwdSha256: sha256(cwd) };
        try {
          if (await canonicalRepositoryRoot(cwd) !== this.proposal?.root) receipt.invalidated = true;
        } catch { receipt.invalidated = true; }
        if (execution.outputCapped) receipt.invalidated = true;
      }
    }
    if (generation !== this.generation || signal.aborted) return;
    try {
      const current = await this.current(signal);
      if (stableJson(current.files) !== stableJson(receipt.files) ||
        stableJson(await this.digests(receipt.tests.map((file) => file.path), signal)) !== stableJson(receipt.tests) ||
        receipt.environment !== this.environment()) receipt.invalidated = true;
    } catch { receipt.invalidated = true; }
    if (generation !== this.generation || signal.aborted) return;
    this.receipts.set(id, receipt);
    while (this.receipts.size > 64) this.receipts.delete(this.receipts.keys().next().value!);
  }
  resultPrepared(result: Readonly<ToolResult>, tool = "bash"): void {
    for (const receipt of this.receipts.values()) if (receipt.toolCallId === result.toolCallId) {
      receipt.prepared = true;
      // Even uncapped output cannot prove arbitrary assertions. Keep outcome limited.
      receipt.limited = true;
      if (tool !== "bash" || result.capped || result.isError || typeof result.content !== "string" ||
        receipt.outputSha256 !== sha256(result.content)) receipt.invalidated = true;
      if (receipt.invalidated) receipt.prepared = false;
    }
  }
  async inspect(handle: string, ids: readonly string[], args: string, signal: AbortSignal, modelJudgment?: string) {
    const observation: ProgrammaticCommandVerificationState = { reviewedContent: "unavailable", behavior: "unavailable", executionApproved: false };
    this.report = undefined; this.verified = undefined; this.pendingPreview = undefined;
    if (this.proposal?.proposal.proposalId !== handle || ids.length > 64)
      return { status: "unavailable", ...programmaticCommandVerificationStateSchema.parse(observation), reason: "unknown-session-proposal" };
    const generation = this.generation;
    try {
      const current = await this.current(signal, observation);
      if (generation !== this.generation || signal.aborted) throw new Error("cancelled");
      observation.reviewedContent = "current";
      const selected: Receipt[] = [];
      for (const id of ids) {
        const receipt = this.receipts.get(id);
        if (!receipt || !receipt.prepared || receipt.environment !== this.environment() || stableJson(receipt.files) !== stableJson(current.files) ||
          stableJson(receipt.tests) !== stableJson(await this.digests(receipt.tests.map((test) => test.path), signal)))
          throw new Error("missing-or-stale-tool-receipt");
        selected.push(receipt);
      }
      if (generation !== this.generation || signal.aborted || this.proposal?.proposal.proposalId !== handle) throw new Error("cancelled");
      const expanded = appendCommandArguments(current.prompt, args);
      const proposal = this.proposal;
      const family = proposal.generator;
      const generator = family && evaluateGeneratorVerification({ reference: family.reference,
        referenceCheck: await checkReferenceReproduction({ root: proposal.root, metadata: family, io: familyIo, signal, runtimeExecutable: this.runtime(),
          helpers: proposal.proposal.files.filter((file) => file.path.startsWith(`${family.helperDirectory}/`)).map((file) => ({ path: file.path, sha256: file.proposedSha256 })),
          referenceFiles: proposal.prerequisites.filter((file) => family.referenceFiles.includes(file.path)) }),
        detectedCommands: detectVerifyCommands(proposal.root, detectLanguages(proposal.root)).map((item) => item.command),
        receipts: selected.map((receipt) => ({ command: receipt.command, exitCode: receipt.execution?.exitCode })) });
      if (generation !== this.generation || signal.aborted || this.proposal !== proposal) throw new Error("cancelled");
      const check = generator?.referenceCheck;
      const referenceCase = generator && check ? [{ category: "reproduces-reference", scenario: "normal", method: "deterministic",
        input: `--member ${generator.reference}`, result: check.result, evidence: { version: 1, items: [
          { basis: "observed", source: "command-verification", code: "reproduces-reference", severity: check.result === "passed" ? "info" : "error",
            message: `${generator.statement}`.slice(0, FAMILY_GENERATOR_LIMITS.evidenceChars) },
          ...(check.result === "failed" ? check.differences.slice(0, 40).map((item) => ({ basis: "observed", source: "command-verification",
            code: `reference-${item.kind}`, severity: "error", message: `${item.kind}: ${item.path}${item.firstDifferentByte === undefined ? "" : ` (first different byte ${item.firstDifferentByte})`}`.slice(0, FAMILY_GENERATOR_LIMITS.evidenceChars) })) : [])] } }] : [];
      this.report = programmaticVerificationV1Schema.parse({ version: 1, snapshot: this.proposal.proposal.snapshot,
        result: check?.result === "failed" ? "failed" : "unavailable", provider: "deterministic", model: "no-model", environment: this.environment(),
        limits: ["Loading is checked through actual discovery and shared append-argument behavior, not a model trial.",
          "Tool receipts prove observed calls and exact content only. Opaque shell output and requested assertions cannot establish behavioral pass.",
          "Persistent bash execution evidence is unavailable: launch cwd and host environment do not attest the reused shell's cwd or exports. Use a separately approved nonpersistent foreground call.",
          "Execution is not approved. Reports are session-local; edits invalidate evidence.",
          "Only declared prerequisite files/package manifests and selected runtime environment are fingerprinted; unlisted dependency source is not established.",
          ...(generator ? ["The reproduces-reference case proves these output bytes for the reference's own inputs under this Node runtime only; other family members are not generated or checked."] : [])],
        cases: [{ category: "loads", scenario: "normal", method: "deterministic", input: args || "(empty arguments)", result: "passed",
          evidence: { version: 1, items: [{ basis: "observed", source: "command-verification", code: "loading",
            severity: "info", message: `Exact owner, raw files, parsed prompt and argument append checked. Expanded SHA-256: ${sha256(expanded)}` }] } }, ...referenceCase],
      });
      const result = { status: "inspected", ...programmaticCommandVerificationStateSchema.parse(observation), report: this.report,
        receipts: selected, availableReceiptIds: [...this.receipts.keys()],
        recommendation: { command: this.proposal.proposal.snapshot.command, snapshot: this.proposal.proposal.snapshot,
          loading: "current", behavior: "unavailable", executionApproved: false,
          helperScope: this.proposal.proposal.snapshot.helpers.length ? "Explicit reviewed helpers rehashed in this session only; advisory script availability remains unsupported." : "No reviewed helpers." },
        ...(generator ? { generator } : {}),
        ...(modelJudgment ? { modelJudgment: { basis: "model-judgment", claim: modelJudgment, ...this.model() } } : {}),
        limitation: "No host-established deterministic behavioral assertions; never infer them from zero exit or printed claims." };
      if (stableJson(result).length > 96_000) {
        this.report = undefined;
        return { status: "unavailable", ...programmaticCommandVerificationStateSchema.parse(observation), reason: "evidence-size-limit" };
      }
      if (generator?.generatorVerified) this.verified = { proposalId: handle, files: current.files, verification: structuredClone(generator) };
      return structuredClone(result);
    } catch {
      this.report = undefined;
      if (generation !== this.generation || signal.aborted) {
        delete observation.loads;
        observation.reviewedContent = "unavailable";
      }
      return { status: "unavailable", ...programmaticCommandVerificationStateSchema.parse(observation), reason: "stale-unreadable-content-environment-or-receipt" };
    }
  }
}
