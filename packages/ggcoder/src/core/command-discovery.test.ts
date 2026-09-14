import { describe, expect, it, vi } from "vitest";
import { SLASH_COMMAND_INPUT_ALL, type SlashCommandListing } from "@kenkaiiii/gg-core";
import { discoverCommands, projectAdvisoryCommands, type CommandDiscovery } from "./command-discovery.js";

vi.mock("./custom-commands.js", () => ({ loadCustomCommands: async () => [
  { name: "fixture", scope: "project", description: "Custom command from /private/owner", prompt: "PRIVATE BODY", filePath: "/private/owner/fixture.md" },
] }));
const action: SlashCommandListing = {
  name: "fixture", aliases: ["fixture-alias"], description: "Action", input: { ...SLASH_COMMAND_INPUT_ALL }, source: "built-in",
};

describe("derived command discovery", () => {
  it("uses live host registry entries and case-insensitive host interception", async () => {
    let actions: SlashCommandListing[] = [];
    const options = { getRegistryActions: () => actions };
    expect((await discoverCommands("unused", options)).resolve("later")).toBeUndefined();
    actions = [{ ...action, name: "later" }];
    expect((await discoverCommands("unused", options)).resolve("later")?.listing.invocationKind).toBe("workspace-action");
    const host = await discoverCommands("unused", { workspaceActions: [{ ...action, name: "FIXTURE" }], workspaceCaseInsensitive: true });
    expect(host.entries.some((entry) => entry.custom?.name === "fixture")).toBe(false);
  });

  it("advances past a single oversized escaped metadata row without losing its identity", () => {
    const discovery: CommandDiscovery = { entries: [{ listing: {
      ...action, description: "\u0001".repeat(4000), usage: "\u0001".repeat(4000),
      origin: "built-in", invocationKind: "workspace-action",
    } }], resolve: () => undefined };
    const page = projectAdvisoryCommands(discovery);
    expect(page.entries).toEqual([expect.objectContaining({ name: "fixture", metadataLimited: true })]);
    expect(page.nextOffset).toBeNull();
    expect(page.limitedCoverage).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(32_000);
  });
  it("preserves host interception but custom-over-registry precedence", async () => {
    const workspace = await discoverCommands("unused", { workspaceActions: [action] });
    expect(workspace.resolve("fixture-alias")?.listing.invocationKind).toBe("workspace-action");
    expect(workspace.resolve("fixture")?.custom).toBeUndefined();
    const registry = await discoverCommands("unused", { registryActions: [action] });
    expect(registry.resolve("fixture")?.listing.origin).toBe("project-custom");
    expect(registry.resolve("fixture")?.listing.description).toBe("Custom command");
    expect(registry.resolve("fixture-alias")?.listing.invocationKind).toBe("workspace-action");
    expect(JSON.stringify(projectAdvisoryCommands(registry))).not.toContain("PRIVATE BODY");
    expect(JSON.stringify(projectAdvisoryCommands(registry))).not.toContain("/private");
  });

  it("bounds pages including serialized text and reports continuation", () => {
    const entries = Array.from({ length: 201 }, (_, index) => ({ listing: {
      ...action, name: `command-${index}`, description: "\"".repeat(4_000), origin: "built-in" as const,
      invocationKind: "workspace-action" as const,
    } }));
    const discovery: CommandDiscovery = { entries, resolve: () => undefined };
    let offset = 0;
    const names: string[] = [];
    do {
      const page = projectAdvisoryCommands(discovery, offset);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(32_000);
      expect(page.limitedCoverage).toBe(true);
      names.push(...page.entries.map((entry) => entry.name));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset < entries.length);
    expect(names).toEqual(entries.map((entry) => entry.listing.name));
  });
});
