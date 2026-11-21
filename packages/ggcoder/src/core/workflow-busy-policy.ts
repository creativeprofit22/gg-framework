import { parseSlashCommandInput } from "./slash-commands.js";

export const WORKFLOW_BUSY_MESSAGE =
  "Wait for the current work to finish, then try again. This request was not added to a waiting list.";

/** These commands require fresh dispatch through setup/readiness/approval gates, never raw steering. */
export function workflowQueuePolicyError(text: string): string | null {
  const name = parseSlashCommandInput(text)?.name;
  return name === "setup-programmatic" || name === "programmatic" || name === "programmatic-run"
    ? WORKFLOW_BUSY_MESSAGE
    : null;
}
