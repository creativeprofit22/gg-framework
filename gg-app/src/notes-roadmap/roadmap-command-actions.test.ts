import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../agent";
import { resolveRoadmapCommandActions } from "./roadmap-command-actions";

const command = (name: string, aliases: string[] = []): SlashCommand => ({
  name,
  aliases,
  description: name,
  input: { text: "optional", references: "optional", attachments: "optional" },
  source: "custom",
});

describe("resolveRoadmapCommandActions", () => {
  it("resolves canonical names and aliases case-insensitively in fixed order", () => {
    expect(
      resolveRoadmapCommandActions([
        command("Release", ["SHIP"]),
        command("TRACE"),
        command("Diff", ["Compare"]),
        command("parity"),
      ]),
    ).toEqual([
      { canonicalName: "compare", label: "Run /compare", invocation: "/Diff" },
      { canonicalName: "trace", label: "Run /trace", invocation: "/TRACE" },
      { canonicalName: "parity", label: "Run /parity", invocation: "/parity" },
      { canonicalName: "ship", label: "Run /ship", invocation: "/Release" },
    ]);
  });

  it("omits missing commands and deduplicates one command matching multiple actions", () => {
    expect(
      resolveRoadmapCommandActions([command("multi", ["compare", "trace"]), command("unrelated")]),
    ).toEqual([{ canonicalName: "compare", label: "Run /compare", invocation: "/multi" }]);
  });
});
