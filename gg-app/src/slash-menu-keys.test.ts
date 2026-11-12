import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./agent";
import {
  orderSlashMatches,
  slashMenuInputAria,
  slashMenuKeyAction,
  slashOptionId,
} from "./slash-menu-keys";

function cmd(name: string, aliases: string[] = []): SlashCommand {
  return {
    name,
    aliases,
    description: name,
    input: { text: "optional", references: "optional", attachments: "optional" },
    source: "built-in",
  };
}

const STEROIDS = cmd("steroids");
const STEROIDS_PLUS = cmd("steroids-plus");
const SCHEDULE = cmd("schedule", ["sched"]);
const ADD_DIR = cmd("add-dir");
const PLAN = cmd("plan", ["pl"]);

function act(
  key: string,
  token: string,
  matches: SlashCommand[],
  activeIndex = 0,
  shiftKey = false,
) {
  return slashMenuKeyAction({ key, shiftKey, token, matches, activeIndex });
}

describe("orderSlashMatches", () => {
  it("puts exact name and alias matches first and keeps the rest in order", () => {
    expect(orderSlashMatches([STEROIDS_PLUS, STEROIDS], "steroids")).toEqual([
      STEROIDS,
      STEROIDS_PLUS,
    ]);
    const other = cmd("plank");
    expect(orderSlashMatches([other, PLAN], "pl")).toEqual([PLAN, other]);
    expect(orderSlashMatches([STEROIDS_PLUS, STEROIDS], "ster")).toEqual([STEROIDS_PLUS, STEROIDS]);
  });
});

describe("slashMenuKeyAction", () => {
  it("sends on Enter when the highlighted command matches the typed token exactly", () => {
    expect(act("Enter", "steroids", [STEROIDS, STEROIDS_PLUS])).toEqual({
      kind: "send",
      command: STEROIDS,
      picker: false,
    });
  });

  it("sends on Enter for an exact alias match", () => {
    expect(act("Enter", "pl", [PLAN])).toEqual({ kind: "send", command: PLAN, picker: false });
  });

  it("completes instead of sending when the typed token matches only without case", () => {
    expect(act("Enter", "Steroids", [STEROIDS])).toEqual({ kind: "complete", command: STEROIDS });
    expect(act("Enter", "PL", [PLAN])).toEqual({ kind: "complete", command: PLAN });
    const deploy = cmd("Deploy");
    expect(act("Enter", "deploy", [deploy])).toEqual({ kind: "complete", command: deploy });
    expect(act("Enter", "Deploy", [deploy])).toEqual({
      kind: "send",
      command: deploy,
      picker: false,
    });
  });

  it("completes on Enter for a partial match", () => {
    expect(act("Enter", "ster", [STEROIDS])).toEqual({ kind: "complete", command: STEROIDS });
  });

  it("completes the highlighted row on Enter when the user moved off the exact match", () => {
    expect(act("Enter", "steroids", [STEROIDS, STEROIDS_PLUS], 1)).toEqual({
      kind: "complete",
      command: STEROIDS_PLUS,
    });
  });

  it("always completes on Tab, even for an exact match", () => {
    expect(act("Tab", "steroids", [STEROIDS])).toEqual({ kind: "complete", command: STEROIDS });
  });

  it("keeps completing /schedule and its alias on Enter", () => {
    expect(act("Enter", "schedule", [SCHEDULE])).toEqual({ kind: "complete", command: SCHEDULE });
    expect(act("Enter", "sched", [SCHEDULE])).toEqual({ kind: "complete", command: SCHEDULE });
  });

  it("routes an exact folder command through the picker", () => {
    expect(act("Enter", "add-dir", [ADD_DIR])).toEqual({
      kind: "send",
      command: ADD_DIR,
      picker: true,
    });
  });

  it("moves with the arrow keys and dismisses on Escape", () => {
    expect(act("ArrowDown", "s", [STEROIDS])).toEqual({ kind: "move", delta: 1 });
    expect(act("ArrowUp", "s", [STEROIDS])).toEqual({ kind: "move", delta: -1 });
    expect(act("Escape", "s", [STEROIDS])).toEqual({ kind: "dismiss" });
  });

  it("leaves Shift+Enter, other keys and an empty menu to the caller", () => {
    expect(act("Enter", "steroids", [STEROIDS], 0, true)).toBeNull();
    expect(act("a", "steroids", [STEROIDS])).toBeNull();
    expect(act("Enter", "steroids", [])).toBeNull();
  });
});

describe("slashMenuInputAria", () => {
  it("points at the list and active option only while open", () => {
    expect(slashMenuInputAria({ open: true, listId: "l", activeIndex: 2 })).toEqual({
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-controls": "l",
      "aria-activedescendant": slashOptionId("l", 2),
      "data-slash-menu-open": "true",
    });
    expect(slashMenuInputAria({ open: false, listId: "l", activeIndex: 0 })).toEqual({
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-controls": undefined,
      "aria-activedescendant": undefined,
      "data-slash-menu-open": "false",
    });
  });
});
