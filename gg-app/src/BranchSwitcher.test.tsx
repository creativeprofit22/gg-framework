// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitBranchCreateResponse,
  GitBranchListOk,
  GitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";

vi.mock("./agent", () => ({
  getGitBranches: vi.fn(),
  switchGitBranch: vi.fn(),
  checkGitBranchName: vi.fn(),
  createGitBranch: vi.fn(),
}));

import { checkGitBranchName, createGitBranch, getGitBranches, switchGitBranch } from "./agent";
import { BranchSwitcher, buildBranchSections, createRowFor } from "./BranchSwitcher";

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
  vi.mocked(checkGitBranchName).mockImplementation(async ({ branch }) => ({
    status: "available",
    branch,
  }));
  vi.mocked(createGitBranch).mockReset();
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
    expect(screen.getByRole("status").textContent).toBe(
      "Switching and creating branches are paused while an agent works in this project.",
    );
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
    expect((await screen.findByText(/No branches match/)).textContent).toBe(
      "No branches match “zzz”.",
    );
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

// Search mock: the daemon matches the query anywhere in the name, ignoring case.
function searchMock() {
  vi.mocked(getGitBranches).mockImplementation(async (options) => {
    const query = options?.query?.toLowerCase();
    if (!query) return listing();
    const all = listing();
    const local = all.local.filter((b) => b.name.toLowerCase().includes(query));
    const remoteOnly = all.remoteOnly.filter((b) => b.name.toLowerCase().includes(query));
    return listing({
      local,
      remoteOnly,
      localTotal: local.length,
      remoteOnlyTotal: remoteOnly.length,
    });
  });
}

async function typeSearch(value: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Search branches" }), {
    target: { value },
  });
  await waitFor(() =>
    expect(getGitBranches).toHaveBeenLastCalledWith({ query: value.trim(), paneId: "pane-2" }),
  );
  await screen.findByRole("listbox", { name: "Branches" });
}

const createOption = () => screen.queryByRole("option", { name: /^(Create branch|Switch to)/ });

const created = (to: string): GitBranchCreateResponse => ({
  status: "created",
  from: "feature/x",
  to,
  carriedChanges: false,
});

describe("createRowFor", () => {
  const ready = { status: "ready" as const, data: listing() };
  const available = { status: "available" as const };

  it("offers nothing for an exact local or GitHub-only name, or before the list loads", () => {
    expect(createRowFor(ready, "fix/a", available)).toBeNull();
    expect(createRowFor(ready, "release/9", available)).toBeNull();
    expect(createRowFor({ status: "loading" }, "new", available)).toBeNull();
    expect(createRowFor(ready, "   ", available)).toBeNull();
  });

  it("creates a free name, and stays choosable while checking or when the check failed", () => {
    expect(createRowFor(ready, " fix/new ", available)).toMatchObject({
      kind: "create",
      name: "fix/new",
      check: "available",
      disabled: false,
    });
    expect(createRowFor(ready, "n", { status: "checking" })).toMatchObject({
      check: "checking",
      hint: "Checking name…",
      disabled: false,
    });
    expect(createRowFor(ready, "n", { status: "unknown" })).toMatchObject({
      check: "available",
      hint: null,
      disabled: false,
    });
  });

  it("disables invalid names and taken names with no branch to switch to", () => {
    expect(createRowFor(ready, "a..b", { status: "invalid", reason: "Bad." })).toMatchObject({
      check: "invalid",
      hint: "Bad.",
      disabled: true,
    });
    expect(createRowFor(ready, "fix", { status: "taken", reason: "Clash." })).toMatchObject({
      kind: "create",
      check: "taken",
      disabled: true,
    });
  });

  it("turns a name taken by a differently-capitalised branch into a switch to it", () => {
    expect(createRowFor(ready, "MAIN", { status: "taken", reason: "Exists." })).toMatchObject({
      kind: "switch-to",
      name: "main",
      target: { name: "main", remote: false, current: false },
      hint: "Exists.",
    });
  });
});

describe("BranchSwitcher create row", () => {
  beforeEach(searchMock);

  it("shows the create row last when no branch has the exact name", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("fix");
    await waitFor(() => expect(createOption()?.getAttribute("data-check")).toBe("available"));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["fix/a", "fix/b", "Create branch ‘fix’"]);
    expect(screen.getByRole("group", { name: "New branch" })).toBeTruthy();
  });

  it("hides the create row on an exact local or GitHub-only match", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("fix/a");
    expect(screen.getByRole("option", { name: "fix/a" })).toBeTruthy();
    expect(createOption()).toBeNull();
    await typeSearch("release/9");
    expect(screen.getByRole("option", { name: "release/9" })).toBeTruthy();
    expect(createOption()).toBeNull();
  });

  it("keeps the no-matches line above the create row", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    expect(screen.getByText(/No branches match/)).toBeTruthy();
    expect(createOption()?.textContent).toContain("feat/new");
  });

  it("says it is checking the name, and the row stays choosable", async () => {
    vi.mocked(checkGitBranchName).mockReturnValue(new Promise(() => {}));
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    const row = createOption()!;
    expect(row.getAttribute("data-check")).toBe("checking");
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText("Checking name…").id).toBe(row.getAttribute("aria-describedby"));
  });

  it("disables an invalid name with the daemon's reason, and Enter does nothing", async () => {
    vi.mocked(checkGitBranchName).mockResolvedValue({
      status: "invalid",
      reason: "Branch names can't contain '..'.",
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("a..b");
    await waitFor(() => expect(createOption()?.getAttribute("data-check")).toBe("invalid"));
    expect(createOption()?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Branch names can't contain '..'.")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches" }), { key: "Enter" });
    fireEvent.click(createOption()!);
    expect(createGitBranch).not.toHaveBeenCalled();
  });

  it("offers to switch when the name is taken by a differently-capitalised branch", async () => {
    vi.mocked(checkGitBranchName).mockResolvedValue({
      status: "taken",
      reason: 'A branch named "main" already exists.',
    });
    vi.mocked(switchGitBranch).mockResolvedValue({
      status: "switched",
      from: "feature/x",
      to: "main",
      trackedRemote: null,
      carriedChanges: false,
    });
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("MAIN");
    const row = await screen.findByRole("option", { name: /Switch to ‘main’/ });
    fireEvent.click(row);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledTimes(1));
    expect(switchGitBranch).toHaveBeenCalledWith({ branch: "main", paneId: "pane-2" });
    expect(createGitBranch).not.toHaveBeenCalled();
  });

  it("disables a taken name with no branch in the list to switch to", async () => {
    vi.mocked(checkGitBranchName).mockResolvedValue({
      status: "taken",
      reason: 'A branch "fix/a" already uses "fix" as a folder.',
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("fix");
    await waitFor(() => expect(createOption()?.getAttribute("data-check")).toBe("taken"));
    expect(createOption()?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/already uses "fix" as a folder/)).toBeTruthy();
    fireEvent.click(createOption()!);
    expect(createGitBranch).not.toHaveBeenCalled();
  });

  it("creates with Enter, then closes and returns focus to the branch button", async () => {
    vi.mocked(createGitBranch).mockResolvedValue(created("feat/new"));
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    await waitFor(() => expect(createOption()?.getAttribute("data-check")).toBe("available"));
    const input = screen.getByRole("combobox", { name: "Search branches" });
    expect(input.getAttribute("aria-activedescendant")).toBe(createOption()!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledTimes(1));
    expect(createGitBranch).toHaveBeenCalledWith({ branch: "feat/new", paneId: "pane-2" });
    expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("creates on click after arrowing up to the last row", async () => {
    vi.mocked(createGitBranch).mockResolvedValue(created("fix"));
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("fix");
    const input = screen.getByRole("combobox", { name: "Search branches" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(createOption()!.id);
    fireEvent.click(createOption()!);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledTimes(1));
    expect(createGitBranch).toHaveBeenCalledWith({ branch: "fix", paneId: "pane-2" });
  });

  it("shows creating while the request is in flight and pauses the rows", async () => {
    vi.mocked(createGitBranch).mockReturnValue(new Promise(() => {}));
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText("Creating feat/new…")).toBeTruthy();
    expect(document.querySelector(".branch-switch-menu")?.getAttribute("data-state")).toBe(
      "creating",
    );
    expect(createOption()?.getAttribute("aria-disabled")).toBe("true");
  });

  it("is paused while an agent works", async () => {
    const { trigger } = renderSwitcher({ running: true });
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    expect(createOption()?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(createOption()!);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches" }), { key: "Enter" });
    expect(createGitBranch).not.toHaveBeenCalled();
  });

  it("puts a refusal at create time back on the row", async () => {
    vi.mocked(createGitBranch).mockResolvedValue({
      status: "taken",
      reason: 'A branch named "feat/new" was just created elsewhere.',
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText(/was just created elsewhere/)).toBeTruthy();
    expect(createOption()?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search branches" }));
  });

  it("titles a busy refusal as a create that changed nothing", async () => {
    vi.mocked(createGitBranch).mockResolvedValue({
      status: "busy",
      reason: 'Can\'t create branches while an agent is working in this project ("Chat A").',
      panes: ["Chat A"],
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText("Couldn't create feat/new. Nothing was changed.")).toBeTruthy();
    expect(screen.getByText(/Chat A/)).toBeTruthy();
  });

  it("titles a clash as a create that changed nothing", async () => {
    vi.mocked(createGitBranch).mockResolvedValue({
      status: "conflict",
      reason: "A merge is still in progress.",
      files: [],
      filesTruncated: false,
    });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText("Couldn't create feat/new. Nothing was changed.")).toBeTruthy();
    expect(screen.getByText("A merge is still in progress.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stay on/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Commit first" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to branches" }));
    const input = await screen.findByRole("combobox", { name: "Search branches" });
    expect((input as HTMLInputElement).value).toBe("feat/new");
    expect(document.activeElement).toBe(input);
    expect(createOption()).toBeTruthy();
  });

  it("offers Retry after a failed create, and the retry creates again", async () => {
    vi.mocked(createGitBranch)
      .mockRejectedValueOnce(new Error("git exited with code 128"))
      .mockResolvedValueOnce(created("feat/new"));
    const { trigger, props } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText("Couldn't create feat/new.")).toBeTruthy();
    expect(screen.getByText("git exited with code 128")).toBeTruthy();
    expect(document.querySelector(".branch-switch-menu")?.getAttribute("data-state")).toBe(
      "create-failed",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledTimes(1));
    expect(createGitBranch).toHaveBeenCalledTimes(2);
  });

  it("goes back to the list with the typed name kept and the search focused", async () => {
    vi.mocked(createGitBranch).mockResolvedValue({ status: "not-a-repo" });
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.click(createOption()!);
    expect(await screen.findByText("This folder isn't a git repository.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to branches" }));
    const input = await screen.findByRole("combobox", { name: "Search branches" });
    expect((input as HTMLInputElement).value).toBe("feat/new");
    expect(document.activeElement).toBe(input);
    expect(createOption()).toBeTruthy();
  });

  it("closes on Escape with a name typed, creating nothing", async () => {
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/new");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search branches" }), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(createGitBranch).not.toHaveBeenCalled();
  });

  it("ignores a name check answer that arrives after a newer one was asked", async () => {
    const pending: Array<(value: GitBranchCreateResponse) => void> = [];
    vi.mocked(checkGitBranchName).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const { trigger } = renderSwitcher();
    await openSwitcher(trigger);
    await typeSearch("feat/a");
    await waitFor(() => expect(checkGitBranchName).toHaveBeenCalledTimes(1));
    await typeSearch("feat/ab");
    await waitFor(() => expect(checkGitBranchName).toHaveBeenCalledTimes(2));
    await typeSearch("feat/a");
    await waitFor(() => expect(checkGitBranchName).toHaveBeenCalledTimes(3));
    // The first answer is for the same text but an older request: it must not land.
    pending[0]({ status: "invalid", reason: "Stale answer." });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createOption()?.getAttribute("data-check")).toBe("checking");
    expect(screen.queryByText("Stale answer.")).toBeNull();
    pending[2]({ status: "available", branch: "feat/a" });
    await waitFor(() => expect(createOption()?.getAttribute("data-check")).toBe("available"));
  });
});
