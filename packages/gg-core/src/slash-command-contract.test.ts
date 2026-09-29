import { describe, expect, it } from "vitest";
import {
  CLIENT_OWNED_SLASH_COMMANDS,
  CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES,
  isSlashCommandsResponse,
  isValidProgrammaticFocus,
  normalizeSlashCommandArgumentHint,
  PROGRAMMATIC_FOCUS_MAX_LENGTH,
  SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
  type SlashCommandsResponse,
} from "./slash-command-contract.js";

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

describe("client-owned slash namespace", () => {
  it("reserves the scheduling canonical name and alias without listing backend handlers", () => {
    expect(CLIENT_OWNED_SLASH_COMMANDS.schedule).toEqual({ name: "schedule", aliases: ["sched"] });
    expect(CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES).toEqual(["schedule", "sched"]);
    expect(Object.isFrozen(CLIENT_OWNED_SLASH_COMMANDS.schedule.aliases)).toBe(true);
    expect(Object.isFrozen(CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES)).toBe(true);
  });
});

describe("programmatic focus contract", () => {
  it("bounds UTF-16 units without trimming stored text or rejecting Unicode", () => {
    expect(PROGRAMMATIC_FOCUS_MAX_LENGTH).toBe(4_000);
    expect(isValidProgrammaticFocus("😀".repeat(2_000))).toBe(true);
    expect(isValidProgrammaticFocus("😀".repeat(2_000) + "x")).toBe(false);
    expect(isValidProgrammaticFocus(" " + "x".repeat(4_000))).toBe(false);
    expect(isValidProgrammaticFocus("检查 café\r\nnext\tstep")).toBe(true);
    expect(isValidProgrammaticFocus("")).toBe(false);
    expect(isValidProgrammaticFocus(" \t\r\n ")).toBe(false);
  });

  it("rejects every C0/DEL/C1 control except CR, LF and tab", () => {
    for (let code = 0; code <= 159; code++) {
      const allowed = (code >= 32 && code < 127) || [9, 10, 13].includes(code);
      expect(isValidProgrammaticFocus(`a${String.fromCharCode(code)}b`), String(code)).toBe(allowed);
    }
  });
});

describe("slash-command discovery contract", () => {
  it("retains legacy listings and accepts consistent optional metadata", () => {
    expect(isSlashCommandsResponse(response)).toBe(true);
    for (const metadata of [
      { source: "built-in", origin: "built-in", invocationKind: "prompt" },
      { source: "built-in", invocationKind: "workspace-action" },
      { source: "custom", origin: "project-custom", invocationKind: "prompt" },
      { source: "custom", origin: "global-custom" },
      { source: "custom", argumentHint: "[path or recent — optional]" },
    ])
      expect(
        isSlashCommandsResponse({ commands: [{ ...response.commands[0], ...metadata }] }),
      ).toBe(true);
  });

  it("rejects inconsistent metadata and oversized listing fields", () => {
    for (const metadata of [
      { source: "custom", origin: "built-in" },
      { source: "built-in", origin: "project-custom" },
      { origin: "unknown" },
      { invocationKind: "shell" },
      { source: "custom", invocationKind: "workspace-action" },
      { name: "x".repeat(101) },
      { description: "x".repeat(4_001) },
      { aliases: Array(51).fill("alias") },
      { aliases: ["x".repeat(101)] },
      { usage: "x".repeat(4_001) },
      { argumentHint: "x".repeat(SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH + 1) },
      { argumentHint: 42 },
      { origin: null },
      { invocationKind: null },
    ])
      expect(
        isSlashCommandsResponse({ commands: [{ ...response.commands[0], ...metadata }] }),
      ).toBe(false);
  });
  it("normalizes argument hints to one bounded display line", () => {
    expect(normalizeSlashCommandArgumentHint("  <path>\n  [focus] ")).toBe("<path> [focus]");
    expect(normalizeSlashCommandArgumentHint("   ")).toBeUndefined();
    expect(normalizeSlashCommandArgumentHint(undefined)).toBeUndefined();
    expect(normalizeSlashCommandArgumentHint("a\u0007b")).toBeUndefined();
    const long = normalizeSlashCommandArgumentHint("x".repeat(500));
    expect(long?.length).toBe(SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH);
    expect(long?.endsWith("…")).toBe(true);
  });

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
