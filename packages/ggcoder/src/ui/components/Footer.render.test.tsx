import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer.js";
import { ThemeContext, loadTheme } from "../theme/theme.js";
import { TerminalSizeProvider } from "../hooks/useTerminalSize.js";

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function renderFooter(model: string): string {
  return stripAnsi(
    renderToString(
      <TerminalSizeProvider>
        <ThemeContext.Provider value={loadTheme("dark")}>
          <Footer model={model} tokensIn={1200} cwd="E:/scratch" hideGitBranch />
        </ThemeContext.Provider>
      </TerminalSizeProvider>,
      { columns: 140 },
    ),
  );
}

describe("Footer rendering", () => {
  it("renders Sonnet 5.5 as the short Sonnet label", () => {
    const output = renderFooter("claude-sonnet-5-5");

    expect(output).toMatch(/\bSonnet\b/);
    expect(output).not.toContain("claude-sonnet-5-5");
  });
});
