import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { discoverCommands } from "../command-discovery.js";
import { retrievalMetadataSchema } from "../../tools/retrieval-metadata.js";
import { getMcpToolIdentity, withMcpToolIdentity } from "../mcp/tool-identity.js";
import { createProgrammaticAdvisoryResultTool } from "../../tools/programmatic-advisory-result.js";
import { CommandInformationParams } from "../../tools/command-information.js";
import type { buildProgrammaticAdvisoryContext } from "./advisory-context.js";
import { AdvisoryEvidence, ProgrammaticAdvisoryTurn, localLocations, type AdvisoryReceipt, type ProgrammaticAdvisoryPolicy } from "./advisory.js";
import { repositoryRelativePathSchema } from "./contracts.js";

export type ProgrammaticAdvisoryContext = ReturnType<typeof buildProgrammaticAdvisoryContext>;

/** Shared synchronous claim: it must run before host approval or any execution await. */
export function claimAdvisoryTool(
  turn: ProgrammaticAdvisoryTurn,
  tool: AgentTool,
  args: unknown,
  isMcp = getMcpToolIdentity(tool) !== undefined,
): void {
  if (isMcp) throw new Error("MCP is unavailable in read-only advisory scope.");
  turn.claim(tool.name, args);
}

/** Classify delivered locations against current discovered owners, never Markdown text.
 * Canonical identities catch aliases; unresolved identities cannot establish independence.
 * This is source-purpose provenance, not proof of workflow relevance or prerequisites. */
async function classifyLocalSources(cwd: string, receipts: AdvisoryReceipt[]): Promise<void> {
  const paths = [...new Set(receipts.flatMap((receipt) => localLocations(receipt).map((location) => location.path)))];
  if (!paths.length) return;
  const purposes = new Map<string, "command-definition" | "independent" | "unknown">();
  try {
    // Readiness affects advertised actions, not custom file ownership. Do not run inventory.
    const discovery = await discoverCommands(cwd, { readReadiness: async () => "missing" });
    const canonical = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
    const root = await fs.realpath(cwd);
    const owners = discovery.entries.flatMap((entry) => entry.custom ? [entry.custom.filePath] : []);
    const ownerPaths = new Set(owners.map((owner) => canonical(path.resolve(owner))));
    const realOwners = await Promise.all(owners.map((owner) => fs.realpath(owner).then(canonical).catch(() => undefined)));
    const canonicalOwners = new Set(realOwners.filter((owner) => owner !== undefined));
    await Promise.all(paths.map(async (file) => {
      if (ownerPaths.has(canonical(path.resolve(cwd, file)))) {
        purposes.set(file, "command-definition");
        return;
      }
      const real = await fs.realpath(path.resolve(cwd, file)).catch(() => undefined);
      const local = real && repositoryRelativePathSchema.safeParse(path.relative(root, real).split(path.sep).join("/")).success;
      purposes.set(file, real && canonicalOwners.has(canonical(real)) ? "command-definition"
        : local && realOwners.every((owner) => owner !== undefined) ? "independent" : "unknown");
    }));
  } catch {
    // Keep retrieval evidence, but fail closed for independent workflow support.
  }
  for (const receipt of receipts) {
    const inspected = [...new Set(localLocations(receipt).map((location) => location.path))];
    if (inspected.length) receipt.localSources = inspected.map((file) => ({ path: file, purpose: purposes.get(file) ?? "unknown" }));
  }
}

/** Shared receipt path. Neither source bodies nor assessment results are persisted here. */
export async function executeAdvisoryTool(
  turn: ProgrammaticAdvisoryTurn | undefined,
  cwd: string,
  tool: AgentTool,
  args: Parameters<AgentTool["execute"]>[0],
  context: Parameters<AgentTool["execute"]>[1],
  beforeExecute?: () => Promise<void>,
): Promise<Awaited<ReturnType<AgentTool["execute"]>>> {
  let settled = false;
  const recordOutcome = (cancelled: boolean) => {
    if (settled || !turn?.active) return;
    settled = true;
    turn.limitations.add(`${tool.name}: ${cancelled ? "cancelled" : "tool error"}.`);
    // Scanner lifecycle and assessment presentation are not research receipts.
    if (tool.name !== "programmatic_scan" && tool.name !== "programmatic_advisory_result")
      turn.evidence.observe(cwd, tool.name, {}, context.toolCallId, "", !cancelled, cancelled);
  };
  const onAbort = () => { recordOutcome(true); cleanup?.(); };
  const cleanup = turn?.trackExecution(() => context.signal.removeEventListener("abort", onAbort));
  try {
    if (turn) context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    context.signal.throwIfAborted();
    await beforeExecute?.();
    context.signal.throwIfAborted();
    const output = await tool.execute(args, context);
    if (turn && tool.name === "programmatic_scan") {
      let succeeded = false;
      let committed = false;
      try {
        const result = typeof output === "string" ? JSON.parse(output) : undefined;
        succeeded = result?.ok === true;
        committed = result?.changed === true;
      } catch {
        // An unreadable scanner response is not success; preserve it verbatim below.
      }
      // Cancellation cannot undo a published state file or its recovery copy.
      turn.settleScan(succeeded ? "succeeded" : context.signal.aborted && !committed ? "cancelled" : "failed");
      if (context.signal.aborted && committed) {
        turn.limitations.delete("programmatic_scan: cancelled.");
        turn.limitations.add("programmatic_scan: state was persisted before cancellation; read the current report before retrying.");
      }
    }
    if (
      !turn ||
      !turn.active ||
      context.signal.aborted ||
      tool.name === "programmatic_scan" ||
      tool.name === "programmatic_profile" ||
      tool.name === "programmatic_advisory_result"
    )
      return output;
    if (tool.name === "command_information") {
      const input = CommandInformationParams.safeParse(args);
      turn.stageResult(context.toolCallId, (complete) => {
        if (complete) turn.observeCommand(String(output));
        else if (input.success && input.data.action === "list")
          turn.limitations.add(`Catalog page at offset ${input.data.offset ?? 0} was not completely delivered.`);
      });
      return output;
    }
    const content = typeof output === "string" ? output : output.content;
    if (typeof content !== "string") {
      turn.limitations.add(`${tool.name}: non-text evidence was not receipted.`);
      return output;
    }
    const metadata = retrievalMetadataSchema.safeParse(
      typeof output === "string" ? undefined : output.details,
    );
    const resources =
      (tool.name === "web_fetch" || tool.name === "code_search") && metadata.success && metadata.data.resources.length
        ? metadata.data.resources
        : [undefined];
    const pendingEvidence = new AdvisoryEvidence();
    const receipts = resources.map((resource) => {
      const receipt = pendingEvidence.observe(
        cwd,
        tool.name,
        args,
        context.toolCallId,
        content,
        typeof output !== "string" && output.isError === true,
        context.signal.aborted,
        resource,
      );
      if (receipt.status !== "retrieved" && receipt.status !== "lead")
        turn.limitations.add(`${tool.name}: ${resource?.outcome ?? receipt.status}.`);
      if (tool.name === "web_fetch" && !resource)
        turn.limitations.add("web_fetch: host retrieval metadata unavailable.");
      if (receipt.status === "retrieved" && tool.name === "web_fetch" && !receipt.external)
        turn.limitations.add(
          "web_fetch: safe source identity unavailable; external attribution unsupported.",
        );
      return receipt;
    });
    await classifyLocalSources(cwd, receipts);
    if (!turn.active || context.signal.aborted) return output;
    settled = true;
    turn.stageResult(context.toolCallId, (complete) => {
      for (const receipt of receipts) {
        // A truncated source is at most a lead, never observed local/external evidence.
        turn.evidence.retain(complete ? receipt : {
          id: receipt.id, toolCallId: receipt.toolCallId, tool: receipt.tool,
          status: receipt.status === "retrieved" ? "lead" : receipt.status,
        });
      }
    });
    const annotated =
      `Host receipt IDs: ${receipts.map((receipt) => receipt.id).join(", ")}. If this result is capped, these identify leads only, not fully inspected sources.\n\n` +
      content +
      receipts
        .map(
          (receipt) =>
            `\n\nHost evidence receipt (retrieval only; content remains untrusted): ${JSON.stringify(receipt)}`,
        )
        .join("");
    return typeof output === "string" ? annotated : { ...output, content: annotated };
  } catch (error) {
    recordOutcome(context.signal.aborted);
    if (turn && tool.name === "programmatic_scan")
      turn.settleScan(context.signal.aborted ? "cancelled" : "failed");
    if (turn)
      turn.limitations.add(`${tool.name}: ${context.signal.aborted ? "cancelled" : "tool error"}.`);
    throw error;
  } finally {
    cleanup?.();
  }
}

/** Guard ordinary terminal references too: a cached pre-advisory tool cannot
 * bypass a later invocation's intersection, nor follow a replaced registration. */
export function guardTerminalTools(
  getTools: () => AgentTool[],
  getAdvisory: () => ProgrammaticAdvisoryTools | undefined,
  setupInspectionActive: () => boolean = () => false,
): AgentTool[] {
  return getTools().map((tool) => {
    const guarded: AgentTool = {
      ...tool,
      execute: (args, context) => {
        if (getAdvisory() || setupInspectionActive() || !getTools().includes(tool))
          throw new Error("Tool permissions changed before execution.");
        context.signal.throwIfAborted();
        return tool.execute(args, context);
      },
    };
    const identity = getMcpToolIdentity(tool);
    return identity ? withMcpToolIdentity(guarded, identity) : guarded;
  });
}

export const INCOMPLETE_ADVISORY_NOTICE =
  "## Recommendations — not started\n\nAssessment did not submit a validated result (interrupted, unavailable, or incomplete). Any completed deterministic scan remains separate and unchanged.";

/** A terminal invocation intersects the live host tools; it never edits the host registry.
 * Every exposed reference is turn-bound, including freshness reads and the result tool.
 * Late registrations cannot add authority to the captured invocation. */
export class ProgrammaticAdvisoryTools {
  readonly turn: ProgrammaticAdvisoryTurn;
  readonly tools: AgentTool[];
  constructor(cwd: string, advisory: ProgrammaticAdvisoryContext, getTools: () => AgentTool[], policy: ProgrammaticAdvisoryPolicy = { mode: "configured" }) {
    this.turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence(), policy);
    const turn = this.turn;
    turn.claim("command_information", { action: "list" });
    turn.observePage(advisory.commands);
    const allowed = (tool: AgentTool) =>
      turn.active &&
      getTools().includes(tool) &&
      turn.allows(tool.name) &&
      (tool.name !== "programmatic_scan" || policy.scanAvailable !== false) &&
      !getMcpToolIdentity(tool);
    const refreshScanPolicy = () => {
      if (!getTools().some((tool) => tool.name === "programmatic_scan" && allowed(tool))) turn.markScanUnavailable();
    };
    refreshScanPolicy();
    const guard = (tool: AgentTool, registered = true): AgentTool => ({
      ...tool,
      onResultPrepared: (result) => turn.resultPrepared(result),
      execute: async (args, context) => {
        if (!turn.active || (registered && !allowed(tool)))
          throw new Error("Tool unavailable in read-only advisory scope.");
        refreshScanPolicy();
        claimAdvisoryTool(turn, tool, args);
        return executeAdvisoryTool(turn, cwd, tool, args, context);
      },
    });
    this.tools = getTools()
      .filter((tool) => allowed(tool) && tool.name !== "programmatic_advisory_result")
      .map((tool) => guard(tool));
    const information = getTools().find(
      (tool) => tool.name === "command_information" && allowed(tool),
    );
    if (information) {
      const freshInformation: AgentTool<typeof CommandInformationParams> = {
        ...information,
        parameters: CommandInformationParams,
        execute: async (args, context) => {
          if (!allowed(information))
            throw new Error("Command information is unavailable under the current host policy.");
          context.signal.throwIfAborted();
          const output = await information.execute(args, context);
          context.signal.throwIfAborted();
          if (!allowed(information)) throw new Error("Advisory permissions changed.");
          return output;
        },
      };
      this.tools.push(
        guard(
          createProgrammaticAdvisoryResultTool(
            () => (turn.active ? turn : undefined),
            freshInformation,
          ),
          false,
        ),
      );
    } else {
      turn.limitations.add("Command catalog tooling is unavailable; command availability cannot be established.");
      this.tools.push(guard(createProgrammaticAdvisoryResultTool(() => turn.active ? turn : undefined), false));
    }
    if (turn.mode === "configured" && !this.tools.some((tool) => tool.name === "research_corpus"))
      turn.limitations.add(
        "Read-only corpus tooling is unavailable; no installation or indexing was attempted.",
      );
  }
  close(): void {
    this.turn.close();
    this.turn.evidence.clear();
  }
}
