import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { Writable } from "node:stream";
import { InputArea, type PasteInfo } from "./InputArea.js";
import { ThemeContext, loadTheme } from "../theme/theme.js";

const inputHandlers: Array<(input: string, key: Record<string, boolean>) => void> = [];

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<{ render: typeof render }>();
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      inputHandlers.push(handler);
    },
    useStdin: () => ({ internal_eventEmitter: { emit: vi.fn() } }),
  };
});

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30 }),
}));

vi.mock("./AnimationContext.js", () => ({
  deriveFrame: () => 0,
  useFocusedAnimation: () => ({ active: false, tick: 0 }),
}));

vi.mock("../../utils/image.js", () => {
  const extractImagePaths = async () => ({ imagePaths: [], cleanText: "" });
  const readImageFile = async () => ({ kind: "text", fileName: "unused", content: "" });
  return {
    extractImagePaths,
    extractMediaPaths: extractImagePaths,
    getClipboardImage: async () => null,
    readImageFile,
    readMediaFile: readImageFile,
  };
});

function renderInputArea(onSubmit = vi.fn(), onDiscoverCommands = vi.fn()) {
  inputHandlers.length = 0;
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
  const theme = loadTheme("dark");
  const result = render(
    <ThemeContext.Provider value={theme}>
      <InputArea onSubmit={onSubmit} onAbort={vi.fn()} cwd={process.cwd()} disableMouseTracking onDiscoverCommands={onDiscoverCommands} />
    </ThemeContext.Provider>,
    { stdout, patchConsole: false },
  );
  return { ...result, theme, output: () => output };
}

function enterText(text: string) {
  inputHandlers.at(-1)?.(text, {});
}

function pressEnter() {
  inputHandlers.at(-1)?.("", { return: true });
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

describe("InputArea pasted slash commands", () => {
  it("refreshes on each palette opening, not each character", async () => {
    const discover = vi.fn();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let view!: ReturnType<typeof renderInputArea>;
    await act(async () => { view = renderInputArea(vi.fn(), discover); });
    try {
      await act(async () => { enterText("/"); });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      await act(async () => { enterText("f"); });
      expect(discover).toHaveBeenCalledOnce();
      await act(async () => { pressEnter(); });
      await act(async () => { enterText("/"); });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => { view.unmount(); });
      vi.unstubAllGlobals();
    }
  });
  it("keeps the slash command prefix styled while a pasted placeholder is displayed and submits the original paste", async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const { rerender, theme, output } = renderInputArea(onSubmit);

    const prefix = "/help explain ";
    const pasted = "first line\nsecond line\nthird line";
    const fullInput = prefix + pasted;

    for (const char of prefix) enterText(char);
    enterText(pasted);
    await vi.runOnlyPendingTimersAsync();
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea onSubmit={onSubmit} onAbort={vi.fn()} cwd={process.cwd()} disableMouseTracking />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(output()).toContain("/help explain [Pasted text #33 +3 lines]");
    });
    // ANSI escapes are disabled for this captured Ink stream, but this assertion
    // fails on the original regression where the placeholder dropped the prefix.
    expect(stripAnsi(output())).toContain(" > /help explain [Pasted text #33 +3 lines]");

    pressEnter();

    const expectedPaste: PasteInfo = { offset: prefix.length, length: pasted.length, lineCount: 3 };
    expect(onSubmit).toHaveBeenCalledWith(fullInput, [], expectedPaste);
    vi.useRealTimers();
  });

  it("paints the Gemini-style input background across the full input height", () => {
    const { output } = renderInputArea();

    const plain = stripAnsi(output());
    expect(plain).toContain("▄".repeat(100));
    expect(plain).toContain("▀".repeat(100));
    expect(plain).toContain(" >   Type your message or / to run a command");
  });
});
