import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./agent";
import { commandScope, menuCommands, paletteCommands, paletteGroups } from "./menu-commands";

function command(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name,
    aliases: [],
    description: `${name} description`,
    input: { text: "optional", references: "optional", attachments: "optional" },
    source: "custom",
    ...extra,
  };
}

describe("menuCommands", () => {
  it("adds /schedule first and hides the commit commands", () => {
    const names = menuCommands([
      command("commit"),
      command("setup-commit"),
      command("review"),
    ]).map((c) => c.name);
    expect(names).toEqual(["schedule", "review"]);
  });
});

describe("paletteCommands", () => {
  it("keeps only commands that declare a collection, in their original order", () => {
    const names = paletteCommands([
      command("plain"),
      command("polish", { collection: "demo", group: "everyday" }),
      command("help", { source: "built-in" }),
      command("asset", { collection: "demo" }),
      command("grouped-only", { group: "everyday" }),
    ]).map((c) => c.name);
    expect(names).toEqual(["polish", "asset"]);
  });

  it("returns nothing when no command declares a collection", () => {
    expect(paletteCommands([command("plain"), command("help", { source: "built-in" })])).toEqual([]);
  });
});

describe("paletteGroups", () => {
  it("puts every command without a group in Other instead of hiding it", () => {
    const groups = paletteGroups([command("plain"), command("other")]);
    expect(groups.map((g) => g.label)).toEqual(["Other"]);
    expect(groups[0]?.commands.map((c) => c.name)).toEqual(["other", "plain"]);
  });

  it("orders groups Everyday, Specialist, Setup, Other and omits empty ones", () => {
    const groups = paletteGroups([
      command("loose"),
      command("init", { group: "setup" }),
      command("daily", { group: "everyday" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["everyday", "setup", "other"]);
    expect(groups.map((g) => g.label)).toEqual(["Everyday", "Setup", "Other"]);
  });

  it("sorts project before global before built-in, each alphabetical, and loses nothing", () => {
    const input = [
      command("zeta", { group: "everyday", origin: "global-custom" }),
      command("plain"),
      command("beta", { group: "everyday", origin: "project-custom" }),
      command("alpha", { group: "everyday", origin: "global-custom" }),
      command("omega", { group: "everyday", origin: "project-custom" }),
      command("kit", { group: "specialist", origin: "global-custom" }),
      command("help", { source: "built-in", origin: "built-in" }),
      command("aaa", { origin: "project-custom" }),
    ];
    const groups = paletteGroups(input);
    expect(groups.map((g) => g.key)).toEqual(["everyday", "specialist", "other"]);
    expect(groups[0]?.commands.map((c) => c.name)).toEqual(["beta", "omega", "alpha", "zeta"]);
    expect(groups[2]?.commands.map((c) => c.name)).toEqual(["aaa", "plain", "help"]);
    expect(groups.flatMap((g) => g.commands)).toHaveLength(input.length);
  });
});

describe("commandScope", () => {
  it("labels project, global and built-in commands", () => {
    expect(commandScope(command("a", { origin: "project-custom" }))).toBe("project");
    expect(commandScope(command("b", { origin: "global-custom" }))).toBe("global");
    expect(commandScope(command("c", { source: "built-in", origin: "built-in" }))).toBe("built-in");
    expect(commandScope(command("d", { source: "built-in" }))).toBe("built-in");
  });
});
