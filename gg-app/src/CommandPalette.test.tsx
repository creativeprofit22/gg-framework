// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { CommandProblem, SlashCommand } from "./agent";

afterEach(cleanup);

function command(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name,
    aliases: [],
    description: `${name} description`,
    input: { text: "optional", references: "optional", attachments: "optional" },
    source: "custom",
    origin: "global-custom",
    ...extra,
  };
}

const COMMANDS: SlashCommand[] = [
  command("plain"),
  command("zeta", { group: "specialist" }),
  command("alpha", { group: "specialist", description: "Tidy the layout", effect: "reads" }),
  command("beta", {
    group: "specialist",
    origin: "project-custom",
    argumentHint: "[path]",
    effect: "edits",
  }),
  command("kit", { group: "everyday", effect: "plans" }),
  command("help", { source: "built-in", origin: "built-in" }),
];

function renderPalette(commands: SlashCommand[] = COMMANDS, problems?: CommandProblem[]) {
  const onInsert = vi.fn();
  const onSend = vi.fn();
  const onClose = vi.fn();
  render(
    <CommandPalette
      commands={commands}
      {...(problems ? { problems } : {})}
      onInsert={onInsert}
      onSend={onSend}
      onClose={onClose}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Search commands" });
  return { input, onInsert, onSend, onClose };
}

function optionNames(): string[] {
  return screen
    .queryAllByRole("option")
    .map((option) => option.querySelector(".slash-name")?.textContent ?? "");
}

function activeName(input: HTMLElement): string | undefined {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".slash-name")?.textContent ?? undefined : undefined;
}

function row(name: string): HTMLElement {
  const option = screen.getByText(name).closest<HTMLElement>("[role='option']");
  if (!option) throw new Error(`no option for ${name}`);
  return option;
}

describe("CommandPalette", () => {
  it("lists every command, grouped Everyday/Specialist/Setup/Other with project before global", () => {
    renderPalette();
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-labelledby"))).toHaveLength(3);
    expect(within(groups[0]!).getAllByRole("option")).toHaveLength(1);
    expect(optionNames()).toEqual(["/kit", "/beta", "/alpha", "/zeta", "/plain", "/help"]);
    // Untagged commands are never hidden; they land in Other.
    expect(within(screen.getByRole("group", { name: "Other" })).getByText("/plain")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Other" })).getByText("/help")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(COMMANDS.length);
    expect(screen.getByText("[path]")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
  });

  it("shows a scope label on every row", () => {
    renderPalette();
    const scope = (name: string) => row(name).querySelector(".command-palette-scope")?.textContent;
    expect(scope("/beta")).toBe("project");
    expect(scope("/alpha")).toBe("global");
    expect(scope("/plain")).toBe("global");
    expect(scope("/help")).toBe("built-in");
  });

  it("shows an effect badge only when the command declares an effect", () => {
    renderPalette();
    const effect = (name: string) => row(name).querySelector(".command-palette-effect")?.textContent;
    expect(effect("/kit")).toBe("plans");
    expect(effect("/beta")).toBe("edits");
    expect(effect("/alpha")).toBe("reads");
    expect(effect("/zeta")).toBeUndefined();
    expect(effect("/plain")).toBeUndefined();
    expect(effect("/help")).toBeUndefined();
    // The badge is text, not colour alone, so it is part of the option's name.
    expect(screen.getByRole("option", { name: /\/beta.*edits/ })).toBe(row("/beta"));
  });

  it("labels each group by its hidden visual heading", () => {
    renderPalette();
    const group = screen.getAllByRole("group")[1]!;
    const heading = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    expect(heading?.textContent).toBe("Specialist");
    expect(heading?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("group", { name: "Specialist" })).toBe(group);
  });

  it("shows unreadable and broken command files as an error state, not hidden", () => {
    const { input } = renderPalette(COMMANDS, [
      { file: "broken.md", scope: "project", reason: "unreadable" },
      { file: "half.md", scope: "global", reason: "malformed-frontmatter" },
    ]);
    const panel = screen.getByRole("region", { name: "2 command files have problems" });
    expect(within(panel).getByText("broken.md")).toBeTruthy();
    expect(within(panel).getByText("Couldn't be read, so it isn't listed.")).toBeTruthy();
    expect(within(panel).getByText("half.md")).toBeTruthy();
    expect(within(panel).getByText(/header isn't closed/)).toBeTruthy();
    expect(within(panel).getByText("project")).toBeTruthy();
    expect(within(panel).getByText("global")).toBeTruthy();
    // Problems are announced with the search box but are never selectable rows.
    expect(input.getAttribute("aria-describedby")).toContain(panel.id);
    expect(within(panel).queryAllByRole("option")).toHaveLength(0);
    expect(optionNames()).toHaveLength(COMMANDS.length);
  });

  it("uses singular wording for one problem and shows no panel without problems", () => {
    renderPalette(COMMANDS, [{ file: "long.md", scope: "project", reason: "invalid-name" }]);
    expect(screen.getByRole("region", { name: "1 command file has a problem" })).toBeTruthy();
    expect(
      screen.getByText("Its name is empty or longer than 100 characters, so it isn't listed."),
    ).toBeTruthy();
    cleanup();
    const { input } = renderPalette();
    expect(screen.queryByRole("region")).toBeNull();
    expect(input.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
  });

  it("explains an empty command name without calling it too long", () => {
    renderPalette(COMMANDS, [{ file: ".md", scope: "global", reason: "invalid-name" }]);
    const panel = screen.getByRole("region", { name: "1 command file has a problem" });
    expect(within(panel).getByText(".md")).toBeTruthy();
    expect(
      within(panel).getByText("Its name is empty or longer than 100 characters, so it isn't listed."),
    ).toBeTruthy();
    expect(within(panel).queryByText(/too long to use/)).toBeNull();
  });

  it("still shows the problem panel when there are no commands at all", () => {
    renderPalette([], [{ file: "broken.md", scope: "project", reason: "unreadable" }]);
    expect(screen.getByRole("region", { name: "1 command file has a problem" })).toBeTruthy();
    // With nothing loadable, the empty row says why rather than "No matches".
    expect(screen.getByText("No collection commands could be loaded.")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("wires combobox ARIA to the listbox and focuses the search box", () => {
    const { input } = renderPalette();
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(document.activeElement).toBe(input);
    expect(activeName(input)).toBe("/kit");
    const selected = screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(input.getAttribute("aria-activedescendant"));
  });

  it("filters by name and by description, case-insensitively", () => {
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: "BET" } });
    expect(optionNames()).toEqual(["/beta"]);
    fireEvent.change(input, { target: { value: "tidy" } });
    expect(optionNames()).toEqual(["/alpha"]);
  });

  it("shows a non-selectable empty row when nothing matches", () => {
    const { input, onInsert } = renderPalette();
    fireEvent.change(input, { target: { value: "nothing-here" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("wraps arrow navigation in both directions", () => {
    const { input } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeName(input)).toBe("/help");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeName(input)).toBe("/kit");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeName(input)).toBe("/beta");
  });

  it("jumps with Ctrl/Cmd+Home/End but leaves plain Home/End to the caret", () => {
    const { input } = renderPalette();
    fireEvent.keyDown(input, { key: "End", ctrlKey: true });
    expect(activeName(input)).toBe("/help");
    const home = fireEvent.keyDown(input, { key: "Home" });
    expect(home).toBe(true); // not prevented
    expect(activeName(input)).toBe("/help");
    fireEvent.keyDown(input, { key: "Home", metaKey: true });
    expect(activeName(input)).toBe("/kit");
    expect(fireEvent.keyDown(input, { key: "End" })).toBe(true);
    expect(activeName(input)).toBe("/kit");
  });

  it("resets the highlight to the first row when the search changes", () => {
    const { input } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeName(input)).toBe("/alpha");
    fireEvent.change(input, { target: { value: "a" } });
    expect(activeName(input)).toBe(optionNames()[0]);
  });

  it("inserts on Enter and sends on Shift+Enter", () => {
    const { input, onInsert, onSend } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ name: "beta" }));
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ name: "beta" }));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it("ignores keys during IME composition", () => {
    const { input, onInsert } = renderPalette();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    expect(onInsert).not.toHaveBeenCalled();
    expect(activeName(input)).toBe("/kit");
  });

  it("highlights on hover and inserts on click", () => {
    const { input, onInsert } = renderPalette();
    const alpha = screen.getByText("/alpha").closest("[role='option']")!;
    fireEvent.mouseMove(alpha);
    expect(activeName(input)).toBe("/alpha");
    fireEvent.click(alpha);
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ name: "alpha" }));
  });

  it("closes on Escape through the dialog", () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
