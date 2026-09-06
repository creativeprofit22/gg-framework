export type ProgrammaticRunSelection = { opportunityId: string; configurationSha256: string };

/** Raw app command only: no template lookup, steering, attachments, or model authorization. */
export function parseProgrammaticRunSelection(text: string): ProgrammaticRunSelection | null | "invalid" {
  if (!/^\s*\/programmatic-run(?:\s|$)/i.test(text)) return null;
  const match = /^\/programmatic-run ([a-f0-9]{64}) ([a-f0-9]{64})$/.exec(text.trim());
  return match ? { opportunityId: match[1]!, configurationSha256: match[2]! } : "invalid";
}

export async function handleAppSidecarProgrammaticExecution(options: {
  text: string;
  attachmentCount: number;
  busy: boolean;
  automated: boolean;
  codeMode: boolean;
  claimStart(): boolean;
  respond(status: number, body: Record<string, unknown>): void;
  runAgent(label: string, run: () => Promise<void>): Promise<void>;
  execute(selection: ProgrammaticRunSelection): Promise<void>;
}): Promise<boolean> {
  const selection = parseProgrammaticRunSelection(options.text);
  if (selection === null) return false;
  if (selection === "invalid" || options.attachmentCount || options.automated || !options.codeMode) {
    options.respond(400, { error: "invalid_programmatic_selection", message: "Select exactly one opportunity and its configuration fingerprint in Code mode, without attachments or automation." });
    return true;
  }
  if (options.busy || !options.claimStart()) {
    options.respond(409, { error: "programmatic_execution_busy", message: "Wait for the current run to finish. Opportunity selection is never queued." });
    return true;
  }
  options.respond(202, { queued: false, count: 0 });
  await options.runAgent(options.text, () => options.execute(selection));
  return true;
}
