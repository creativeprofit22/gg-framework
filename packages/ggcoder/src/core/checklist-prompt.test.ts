import { describe, expect, it } from "vitest";
import { CHECKLIST_FILE, CHECKLIST_ITEMS, type ChecklistItem } from "./checklist-items.js";
import { checklistRunPrompt } from "./checklist-prompt.js";

const ITEMS: readonly ChecklistItem[] = CHECKLIST_ITEMS;

function item(id: string): ChecklistItem {
  const found = ITEMS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no checklist item ${id}`);
  return found;
}

describe("checklistRunPrompt", () => {
  it("is report-only and records through the checklist tool", () => {
    const prompt = checklistRunPrompt(item("docs"));

    expect(prompt).toContain("`tool_search`");
    expect(prompt).toContain('`action: "record"`, `id: "docs"`');
    expect(prompt).toContain("Do not edit, create, delete, install or commit any project file");
    expect(prompt).toContain("Only the `checklist` tool writes the record");
    expect(prompt).toContain(CHECKLIST_FILE);
    expect(prompt).toContain("Configuration being present is not a passing check");
    expect(prompt).toContain("`Scope:`");
    expect(prompt).toContain("`Not checked:`");
    expect(prompt).toContain("Loading a skill alone is not review evidence");
    expect(prompt).toContain("Do not run fix/write flags");
  });

  it("names the item's check, skill and setup command when it has them", () => {
    const ci = item("ci");
    const security = item("security");

    expect(checklistRunPrompt(ci)).toContain(ci.check);
    expect(checklistRunPrompt(ci)).toContain("`/setup-ci` would fix most gaps");
    expect(checklistRunPrompt(security)).toContain("Load the `bulletproof` skill");
    expect(checklistRunPrompt(item("docs"))).toContain("No skill applies");
  });
});
