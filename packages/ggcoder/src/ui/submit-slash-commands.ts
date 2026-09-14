import { registryCommandListings } from "../core/command-discovery.js";

export const UI_SLASH_COMMANDS = registryCommandListings([
  { name: "model", aliases: ["m", "models"], description: "Select model" },
  { name: "compact", aliases: ["c"], description: "Compact context" },
  { name: "quit", aliases: ["q", "exit"], description: "Exit GG Coder" },
  { name: "clear", aliases: [], description: "Clear session" },
  { name: "theme", aliases: ["t"], description: "Change theme" },
  { name: "markdown", aliases: ["md"], description: "Toggle rendered markdown" },
  { name: "clearplan", aliases: [], description: "Dismiss approved plan" },
  // App-owned interceptors run before the common UI handler.
  { name: "rewind", aliases: [], description: "Restore a checkpoint" },
  { name: "ideal-on", aliases: [], description: "Enable pre-final review" },
  { name: "ideal-off", aliases: [], description: "Disable pre-final review" },
]).map((command) => ({ ...command, input: { text: "none", references: "none", attachments: "none" } as const }));

interface UiSlashCommandActions {
  openModelSelector: () => void;
  compactConversation: () => Promise<void>;
  quit: () => void;
  clearSession: () => void;
  openThemeSelector: () => void;
  toggleMarkdown: () => void;
  clearApprovedPlan: () => void;
}

export async function handleUiSlashCommand(
  trimmed: string,
  actions: UiSlashCommandActions,
): Promise<boolean> {
  if (trimmed === "/model" || trimmed === "/m" || trimmed === "/models") {
    actions.openModelSelector();
    return true;
  }

  if (trimmed === "/compact" || trimmed === "/c") {
    await actions.compactConversation();
    return true;
  }

  if (trimmed === "/quit" || trimmed === "/q" || trimmed === "/exit") {
    actions.quit();
    return true;
  }

  if (trimmed === "/clear") {
    actions.clearSession();
    return true;
  }

  if (trimmed === "/theme" || trimmed === "/t") {
    actions.openThemeSelector();
    return true;
  }

  if (trimmed === "/markdown" || trimmed === "/md") {
    actions.toggleMarkdown();
    return true;
  }

  if (trimmed === "/clearplan") {
    actions.clearApprovedPlan();
    return true;
  }

  return false;
}
