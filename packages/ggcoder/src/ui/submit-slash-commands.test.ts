import { describe, expect, it, vi } from "vitest";
import { handleUiSlashCommand } from "./submit-slash-commands.js";

function actions() {
  return {
    openModelSelector: vi.fn(),
    compactConversation: vi.fn(async () => {}),
    quit: vi.fn(),
    clearSession: vi.fn(),
    openThemeSelector: vi.fn(),
    toggleMarkdown: vi.fn(),
    clearApprovedPlan: vi.fn(),
  };
}

describe("terminal model selector interception", () => {
  it.each(["/model", "/m", "/models"])("opens the selector for bare %s", async (input) => {
    const handlers = actions();
    expect(await handleUiSlashCommand(input, handlers)).toBe(true);
    expect(handlers.openModelSelector).toHaveBeenCalledOnce();
  });

  it.each(["/model focus", "/m focus", "/models focus", "/model\tfocus", "/model\nfocus"])("leaves %j to prompt resolution", async (input) => {
    const handlers = actions();
    expect(await handleUiSlashCommand(input, handlers)).toBe(false);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });
});
