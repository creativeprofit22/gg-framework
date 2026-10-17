import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { Writable } from "node:stream";
import { SlashCommandMenu, type SlashCommandInfo } from "./SlashCommandMenu.js";
import { ThemeContext, loadTheme } from "../theme/theme.js";

function renderMenu(element: React.ReactElement): string {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;
  stdout.getColorDepth = () => 24;

  render(<ThemeContext.Provider value={loadTheme("dark")}>{element}</ThemeContext.Provider>, {
    stdout,
    patchConsole: false,
  }).unmount();
  return output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

const COMMANDS: SlashCommandInfo[] = [
  {
    name: "contract",
    aliases: [],
    description: "Audit interfaces against implementations",
    argumentHint: "[interface, module, or recent — optional]",
    sectionTitle: "custom",
  },
  { name: "clear", aliases: [], description: "Clear session", sectionTitle: "built-in" },
];

describe("SlashCommandMenu argument hint", () => {
  it("shows the selected command's hint on its own line", () => {
    const output = renderMenu(
      <SlashCommandMenu commands={COMMANDS} selectedIndex={0} width={100} />,
    );

    expect(output).toContain("/contract [interface, module, or recent — optional]");
    expect(output).toContain("Audit interfaces against implementations");
  });

  it("shows no hint line when the selected command has no hint", () => {
    const output = renderMenu(
      <SlashCommandMenu commands={COMMANDS} selectedIndex={1} width={100} />,
    );

    expect(output).toContain("Clear session");
    expect(output).not.toContain("[interface, module");
    expect(output).not.toContain("/clear");
  });
});
