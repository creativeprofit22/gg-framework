// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitBranchListOk,
  GitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";

vi.mock("./agent", () => ({
  getGitBranches: vi.fn(),
  switchGitBranch: vi.fn(),
}));

import { getGitBranches, switchGitBranch } from "./agent";
import { BranchSwitcher, buildBranchSections } from "./BranchSwitcher";

const local = (name: string, lastUsedAt: string | null, current = false) => ({
  name,
  current,
  lastUsedAt,
  upstream: null,
});

function listing(over: Partial<GitBranchListOk> = {}): GitBranchListOk {
  return {
    status: "ok",
    current: { name: "feature/x", detached: false, commit: "abc1234" },
    hasCommits: true,
    remote: "origin",
    defaultBranch: { name: "main", source: "remote-head" },
    local: [
      local("main", "2026-11-01T00:00:00Z"),
      local("feature/x", "2026-11-20T00:00:00Z", true),
      local("fix/a", "2026-11-18T00:00:00Z"),
      local("fix/b", "2026-11-17T00:00:00Z"),
      local("chore/c", "2026-11-16T00:00:00Z"),
      local("chore/d", "2026-11-15T00:00:00Z"),
      local("spike/e", "2026-11-14T00:00:00Z"),
      local("old/f", null),
    ],
    remoteOnly: [{ name: "release/9", remoteRef: "origin/release/9", lastCommitAt: null }],
    localTotal: 8,
    remoteOnlyTotal: 1,
    truncated: false,
    ...over,
  };
}

function renderSwitcher(over: Partial<Parameters<typeof BranchSwitcher>[0]> = {}) {
  const props = {
    branch: "feature/x",
    paneId: "pane-2",
    running: false,
    onSwitched: vi.fn(),
    onCommitFirst: vi.fn(),
    ...over,
  };
  const view = render(<BranchSwitcher {...props} />);
  const trigger = screen.getByRole("button", { name: "feature/x, switch branch" });
  return { ...view, trigger, props };
}

async function openSwitcher(trigger: HTMLElement) {
  fireEvent.click(trigger);
  await screen.findByRole("listbox", { name: "Branches" });
}

beforeEach(() => {
  vi.mocked(getGitBranches).mockResolvedValue(listing());
  vi.mocked(switchGitBranch).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("buildBranchSections", () => {
  it("pins the default first, then up to five recent branches, without the default", () => {
    const sections = buildBranchSections(listing(), false);
    expect(sections.map((s) => s.label)).toEqual(["Default", "Recent"]);
    expect(sections[0].rows.map((r) => r.name)).toEqual(["main"]);
    const recent = sections[1].rows.map((r) => r.name);
    expect(recent).toEqual(["feature/x", "fix/a", "fix/b", "chore/c", "chore/d"]);
    expect(recent).not.toContain("main");
  });

  it("marks the current branch and leaves origin-only branches out while idle", () => {
    const sections = buildBranchSections(listing(), false);
    const all = sections.flatMap((s) => s.rows);
    expect(all.find((r) => r.current)?.name).toBe("feature/x");
    expect(all.some((r) => r.remote)).toBe(false);
  });

  it("shows every match, then origin-only branches under On GitHub only, while searching", () => {
    const sections = buildBranchSections(listing(), true);
    expect(sections.map((s) => s.label)).toEqual(["Branches", "On GitHub only"]);
    expect(sections[0].rows).toHaveLength(8);
    expect(sections[1].rows.map((r) => r.name)).toEqual(["release/9"]);
    expect(sections[1].rows[0].remote).toBe(true);
  });
});

describe("BranchSwitcher", () => {
  it("opens with the search focused and lists the pinned default and recent branches", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search branches" }));
    expect(screen.getByRole("group", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Recent" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "On GitHub only" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows origin-only branches only while searching", async () => {
    vi.mocked(getGitBranches).mockImplementation(async (options) =>
      options?.query ? listing({ local: [local("fix/a", null)] }) : listing(),
    );
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.change(screen.getByRole("combobox", { name: "Search branches" }), {
      target: { value: "rel" },
    });
    await waitFor(() =>
      expect(getGitBranches).toHaveBeenLastCalledWith({ query: "rel", paneId: "pane-2" }),
    );
    expect(await screen.findByRole("group", { name: "On GitHub only" })).toBeTruthy();
  });

  it("lists branches for its own pane, not the window's primary pane", async () => {
    const { trigger } = renderSwitcher({ paneId: "pane-3" });
    await openSwitcher(trigger);
    expect(getGitBranches).toHaveBeenCalledWith({ paneId: "pane-3" });
  });

  it("moves the highlight with arrows and switches with Enter", async () => {
    vi.mocked(switchGitBranch).mockResolvedValue({
      status: "switched",
      from: "feature/x",
      to: "fix/a",
      trackedRemote: null,
      carriedChanges: false,
    });
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    const input = screen.getByRole("combobox", { name: "Search branches" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    // Row 0 is the pinned default, row 1 the current branch, row 2 fix/a.
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2].id);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledTimes(1));
    expect(switchGitBranch).toHaveBeenCalledWith({ branch: "fix/a", paneId: "pane-2" });
    // A switch never forces: the request carries only the branch and its pane.
    expect(Object.keys(vi.mocked(switchGitBranch).mock.calls[0][0])).toEqual(["branch", "paneId"]);
  });

  it("closes on Escape and returns focus to the branch button", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches" }), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the press lands outside, and keeps work safe (no switch)", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    // The opening click's listener is registered a tick late; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull());
    expect(switchGitBranch).not.toHaveBeenCalled();
  });

  it("says why switching is paused while an agent works, and does not switch", async () => {
    const { trigger } = renderSwitcher({ running: true });
    await openSwitcher(trigger);
    expect(screen.getByRole("status").textContent).toContain("paused while an agent works");
    const main = screen.getByRole("option", { name: /main/ });
    expect(main.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(main);
    expect(switchGitBranch).not.toHaveBeenCalled();
  });

  it("shows loading, then a failed list with Retry that recovers", async () => {
    vi.mocked(getGitBranches).mockRejectedValueOnce(new Error("offline"));
    const { trigger } = renderSwitcher();
    fireEvent.click(trigger);
    expect(await screen.findByText("Couldn't load branches.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("listbox", { name: "Branches" });
    expect(getGitBranches).toHaveBeenCalledTimes(2);
  });

  it("shows a no-matches message that names the search", async () => {
    vi.mocked(getGitBranches).mockImplementation(async (options) =>
      options?.query
        ? listing({ local: [], remoteOnly: [], localTotal: 0, remoteOnlyTotal: 0 })
        : listing(),
    );
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.change(screen.getByRole("combobox", { name: "Search branches" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText(/No branches match/)).toBeTruthy();
    expect(screen.getByText(/zzz/)).toBeTruthy();
  });

  it("shows switching while the request is in flight", async () => {
    vi.mocked(switchGitBranch).mockReturnValue(new Promise(() => {}));
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    expect(await screen.findByText("Switching to fix/a…")).toBeTruthy();
  });

  it("lists the clashing files, keeps the branch, and offers Commit first", async () => {
    const conflict: GitBranchSwitchResponse = {
      status: "conflict",
      reason: "Local changes to these files would be overwritten by checkout.",
      files: ["gg-app/src/Deck.tsx", "gg-app/src/Deck.css"],
      filesTruncated: false,
    };
    vi.mocked(switchGitBranch).mockResolvedValue(conflict);
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    expect(await screen.findByText("Couldn't switch to fix/a. Nothing was changed.")).toBeTruthy();
    expect(screen.getByText("gg-app/src/Deck.tsx")).toBeTruthy();
    expect(props.onSwitched).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Commit first" }));
    expect(props.onCommitFirst).toHaveBeenCalledTimes(1);
  });

  it("doesn't blame uncommitted changes when an unfinished merge blocks the switch", async () => {
    const reason =
      'A merge is still in progress, so nothing was changed. Finish or cancel it first or stay on "feature/x".';
    vi.mocked(switchGitBranch).mockResolvedValue({
      status: "conflict",
      reason,
      files: ["src/merged.ts"],
      filesTruncated: false,
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByText(/uncommitted changes/i)).toBeNull();
  });

  it("'Stay on' dismisses the clash and leaves the branch unchanged", async () => {
    vi.mocked(switchGitBranch).mockResolvedValue({
      status: "conflict",
      reason: "Clash.",
      files: ["a.ts"],
      filesTruncated: true,
    });
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stay on feature/x" }));
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull());
    expect(props.onSwitched).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("explains a busy-folder refusal and offers to go back to the list", async () => {
    vi.mocked(switchGitBranch).mockResolvedValue({
      status: "busy",
      reason: 'Can\'t switch branches while an agent is working in this project ("Chat A").',
      panes: ["Chat A"],
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    expect(await screen.findByText("Another chat on this folder is working.")).toBeTruthy();
    expect(screen.getByText(/Chat A/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to branches" }));
    await screen.findByRole("listbox", { name: "Branches" });
  });

  it("shows a thrown switch error without losing the list", async () => {
    vi.mocked(switchGitBranch).mockRejectedValue(new Error("bad name"));
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.click(screen.getByRole("option", { name: /fix\/a/ }));
    expect(await screen.findByText("bad name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to branches" })).toBeTruthy();
  });
});

describe("BranchSwitcher option rows and state marker", () => {
  it("are native buttons kept out of the tab order, and a press keeps focus in search", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    const option = screen.getAllByRole("option")[0];
    expect(option.tagName).toBe("BUTTON");
    expect(option.getAttribute("tabindex")).toBe("-1");
    // A cancelled mousedown means the browser does not move focus off the search box.
    expect(fireEvent.mouseDown(option)).toBe(false);
  });

  it("marks the menu with its state for probes", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    expect(document.querySelector(".branch-switch-menu")?.getAttribute("data-state")).toBe("ready");
  });
});

describe("truncated branch list", () => {
  const NOTE = /Type more to narrow the list/;

  it("notes that a search hit the result cap, but not for the idle list", async () => {
    vi.mocked(getGitBranches).mockResolvedValue(listing({ truncated: true }));
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Search branches" }), {
      target: { value: "fix" },
    });
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it("does not note a search whose results were not cut", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    fireEvent.change(screen.getByRole("combobox", { name: "Search branches" }), {
      target: { value: "fix" },
    });
    await waitFor(() =>
      expect(getGitBranches).toHaveBeenLastCalledWith({ query: "fix", paneId: "pane-2" }),
    );
    await screen.findByRole("listbox", { name: "Branches" });
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
