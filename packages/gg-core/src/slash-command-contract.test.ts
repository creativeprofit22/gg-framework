import { describe, expect, it } from "vitest";
import { isSlashCommandsResponse, type SlashCommandsResponse } from "./slash-command-contract.js";

const response: SlashCommandsResponse = {
  commands: [
    {
      name: "programmatic",
      aliases: [],
      description: "Run the bounded programmatic scan",
      input: { text: "none", references: "none", attachments: "none" },
      source: "built-in",
    },
  ],
};

describe("slash-command discovery contract", () => {
  it("requires explicit text, reference, and attachment policies", () => {
    expect(isSlashCommandsResponse(response)).toBe(true);
    for (const input of [
      { references: "none", attachments: "none" },
      { text: "none", attachments: "none" },
      { text: "none", references: "none" },
    ]) {
      expect(isSlashCommandsResponse({ commands: [{ ...response.commands[0], input }] })).toBe(
        false,
      );
    }
  });
});
