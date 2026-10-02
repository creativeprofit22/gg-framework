// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  createProject,
  getSettings,
  importTranscript,
  listProjects,
  listSessions,
  saveSettings,
  setProjectHidden,
  waitForReady,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { describeOpenFailure } from "./open-failure";
import { ProjectPicker } from "./ProjectPicker";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  createProject: vi.fn(),
  focusWindowByOffset: vi.fn(),
  getSettings: vi.fn(),
  importTranscript: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  saveSettings: vi.fn(),
  setProjectHidden: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));

const openFolderDialogMock = vi.mocked(openFolderDialog);
const bindProjectMock = vi.fn<(cwd: string, sessionPath?: string) => Promise<void>>();
const createProjectMock = vi.mocked(createProject);
const getSettingsMock = vi.mocked(getSettings);
const importTranscriptMock = vi.mocked(importTranscript);
const listProjectsMock = vi.mocked(listProjects);
const listSessionsMock = vi.mocked(listSessions);
const saveSettingsMock = vi.mocked(saveSettings);
const setProjectHiddenMock = vi.mocked(setProjectHidden);
const waitForReadyMock = vi.mocked(waitForReady);

const PROJECT: DiscoveredProject = {
  name: "ui-test",
  path: "/Users/dev/ui-test",
  lastActiveDisplay: "1w ago",
  sources: ["claude-code"],
};

const NATIVE_SESSION: RecentSession = {
  id: "gg-1",
  path: "/sessions/gg-1.jsonl",
  preview: "Native GG Coder session",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
};

const FOREIGN_SESSION: RecentSession = {
  id: "cc-1",
  path: "/Users/dev/.claude/projects/-Users-dev-ui-test/cc-1.jsonl",
  preview: "Build a UI dashboard in HTML",
  lastActiveDisplay: "1w ago",
  messageCount: 44,
  source: "claude-code",
};

/** Render the picker already opened on the project's session list. */
async function renderSessionList(sessions: RecentSession[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue([PROJECT]);
  listSessionsMock.mockResolvedValue(sessions);
  bindProjectMock.mockResolvedValue();

  render(
    <ProjectPicker
      onChosen={vi.fn()}
      bindProject={bindProjectMock}
      initialProjectPath={PROJECT.path}
    />,
  );
  await screen.findByText(sessions[0]!.preview);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OTHER_PROJECT: DiscoveredProject = {
  name: "scratch",
  path: "/private/tmp",
  lastActiveDisplay: "1d ago",
  sources: ["ggcoder"],
};

/** Render the picker on the project list (no deep link). */
async function renderProjectList(projects: DiscoveredProject[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue(projects);

  render(<ProjectPicker onChosen={vi.fn()} bindProject={bindProjectMock} />);
  await screen.findByText(projects[0]!.name);
}

describe("ProjectPicker discovery", () => {
  it("matches a selected Windows project across extended-path and casing forms", async () => {
    const windowsProject: DiscoveredProject = {
      ...PROJECT,
      path: "C:\\ggcoder-projects\\My-App",
    };
    getSettingsMock.mockResolvedValue({
      projectsRoot: "C:\\ggcoder-projects",
      configured: true,
    });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([windowsProject]);
    listSessionsMock.mockResolvedValue([NATIVE_SESSION]);

    render(
      <ProjectPicker
        onChosen={vi.fn()}
        bindProject={bindProjectMock}
        initialProjectPath={"\\\\?\\c:\\GGCODER-PROJECTS\\my-app\\"}
      />,
    );

    expect(await screen.findByText(NATIVE_SESSION.preview)).toBeTruthy();
    expect(listSessionsMock).toHaveBeenCalledWith(windowsProject.path);
  });

  it("shows a retryable error when project listing fails", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce([PROJECT]);

    render(<ProjectPicker onChosen={vi.fn()} bindProject={bindProjectMock} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load projects");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(PROJECT.name)).toBeTruthy();
    expect(listProjectsMock).toHaveBeenCalledTimes(2);
  });

  it("adds a parent projects folder, saves it, and reloads its direct children", async () => {
    const child: DiscoveredProject = {
      name: "direct-child",
      path: "/Users/workspace/direct-child",
      lastActiveDisplay: "now",
      sources: ["ggcoder"],
    };
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValueOnce([PROJECT]).mockResolvedValueOnce([PROJECT, child]);
    openFolderDialogMock.mockResolvedValue("/Users/workspace");
    saveSettingsMock.mockResolvedValue();

    render(<ProjectPicker onChosen={vi.fn()} bindProject={bindProjectMock} />);
    await screen.findByText(PROJECT.name);

    expect(screen.getByRole("button", { name: "Open project directly" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add projects folder" }));

    expect(await screen.findByText(child.name)).toBeTruthy();
    expect(saveSettingsMock).toHaveBeenCalledWith("/Users/workspace");
    expect(listProjectsMock).toHaveBeenCalledTimes(2);
  });
});

describe("ProjectPicker project creation", () => {
  function renderCreationPickers(
    bindB: (cwd: string, sessionPath?: string) => Promise<unknown>,
    chosenB: (cwd: string) => void,
  ) {
    const bindA = vi.fn().mockResolvedValue(undefined);
    const chosenA = vi.fn();
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([]);
    createProjectMock.mockResolvedValue("/Users/dev/project-c");
    bindProjectMock.mockResolvedValue();
    render(
      <>
        <div data-testid="picker-a">
          <ProjectPicker onChosen={chosenA} bindProject={bindA} showWindowControls={false} />
        </div>
        <div data-testid="picker-b">
          <ProjectPicker onChosen={chosenB} bindProject={bindB} showWindowControls={false} />
        </div>
      </>,
    );
    return { bindA, chosenA };
  }

  async function createFromPickerB(): Promise<void> {
    const pickerB = within(screen.getByTestId("picker-b"));
    fireEvent.click(await pickerB.findByRole("button", { name: "+ New project" }));
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "Project C" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  }

  it("binds a new project only through the initiating picker", async () => {
    let finishBinding!: () => void;
    const bindB = vi.fn(() => new Promise<void>((resolve) => (finishBinding = resolve)));
    const chosenB = vi.fn();
    const { bindA, chosenA } = renderCreationPickers(bindB, chosenB);

    await createFromPickerB();

    await waitFor(() => expect(bindB).toHaveBeenCalledWith("/Users/dev/project-c"));
    expect(bindA).not.toHaveBeenCalled();
    expect(bindProjectMock).not.toHaveBeenCalled();
    expect(chosenA).not.toHaveBeenCalled();
    expect(chosenB).not.toHaveBeenCalled();

    finishBinding();
    await waitFor(() => expect(chosenB).toHaveBeenCalledWith("/Users/dev/project-c"));
  });

  it("previews the projects folder re-read after a settings refresh", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/old-root", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([]);

    const { rerender } = render(
      <ProjectPicker
        onChosen={vi.fn()}
        bindProject={bindProjectMock}
        refreshSignal={0}
        showWindowControls={false}
      />,
    );
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));

    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/new-root", configured: true });
    rerender(
      <ProjectPicker
        onChosen={vi.fn()}
        bindProject={bindProjectMock}
        refreshSignal={1}
        showWindowControls={false}
      />,
    );
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(2));

    // The empty-list state shows a second "+ New project" button; either opens the modal.
    fireEvent.click((await screen.findAllByRole("button", { name: "+ New project" }))[0]!);
    const dialog = screen.getByRole("dialog", { name: "New project" });
    await waitFor(() => expect(dialog.textContent).toContain("/Users/new-root/"));
    expect(dialog.textContent).not.toContain("/Users/old-root");
  });

  it("keeps the modal open when the initiating picker cannot bind", async () => {
    const bindB = vi.fn().mockRejectedValue(new Error("binding failed"));
    const chosenB = vi.fn();
    const { bindA, chosenA } = renderCreationPickers(bindB, chosenB);

    await createFromPickerB();

    expect(await screen.findByText("binding failed")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
    expect(bindA).not.toHaveBeenCalled();
    expect(chosenA).not.toHaveBeenCalled();
    expect(chosenB).not.toHaveBeenCalled();
  });
});

describe("ProjectPicker hide", () => {
  it("removes the row and persists the decision", async () => {
    setProjectHiddenMock.mockResolvedValue();
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide scratch"));

    await waitFor(() => expect(screen.queryByText("scratch")).toBeNull());
    expect(setProjectHiddenMock).toHaveBeenCalledWith("/private/tmp", true);
    // The untouched project stays put.
    expect(screen.getByText("ui-test")).toBeTruthy();
  });

  it("restores the row in place when persisting fails", async () => {
    setProjectHiddenMock.mockRejectedValue(new Error("disk full"));
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide ui-test"));

    // Comes back rather than lying about what the next launch will show, and
    // returns to its original position rather than the end of the list.
    await waitFor(() => expect(screen.getByText("ui-test")).toBeTruthy());
    const names = screen.getAllByText(/^(ui-test|scratch)$/).map((n) => n.textContent);
    expect(names).toEqual(["ui-test", "scratch"]);
  });
});

describe("ProjectPicker session list", () => {
  it("shows a retryable error when session listing fails", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([PROJECT]);
    listSessionsMock
      .mockRejectedValueOnce(new Error("session scan failed"))
      .mockResolvedValueOnce([NATIVE_SESSION]);

    render(<ProjectPicker onChosen={vi.fn()} bindProject={bindProjectMock} />);
    fireEvent.click(await screen.findByText(PROJECT.name));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load sessions");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(NATIVE_SESSION.preview)).toBeTruthy();
    expect(listSessionsMock).toHaveBeenCalledTimes(2);
  });

  it("badges a Claude Code session with its source", async () => {
    await renderSessionList([NATIVE_SESSION, FOREIGN_SESSION]);

    // The foreign row is labelled; the native one carries no source tag.
    const badge = screen.getByText("Claude Code");
    expect(badge.className).toContain("picker-source-tag");
    // Theme token, not raw hex, so Light can swap in readable ink.
    expect(badge.style.color).toBe("var(--source-claude-code)");
    expect(badge.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}\b/i);

    const foreignRow = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(foreignRow?.textContent).toContain("Claude Code");
    expect(foreignRow?.getAttribute("title")).toContain("opens as a Supah Coder session");

    const nativeRow = screen.getByText(NATIVE_SESSION.preview).closest("button");
    expect(nativeRow?.textContent).not.toContain("Claude Code");
    expect(nativeRow?.getAttribute("title")).toBeNull();
  });

  it("imports then opens when a foreign session is clicked", async () => {
    importTranscriptMock.mockResolvedValue({
      ok: true,
      sessionId: "imported-1",
      sessionPath: "/sessions/imported-1.jsonl",
      cwd: PROJECT.path,
      format: "claude",
      messageCount: 44,
      dropped: "nothing",
    });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    await waitFor(() => {
      // Imported from the foreign transcript...
      expect(importTranscriptMock).toHaveBeenCalledWith(FOREIGN_SESSION.path, PROJECT.path);
      // ...then opened by the NEW session path, not the transcript path.
      expect(bindProjectMock).toHaveBeenCalledWith(PROJECT.path, "/sessions/imported-1.jsonl");
    });
  });

  it("opens a native session directly, with no import", async () => {
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

    await waitFor(() => {
      expect(bindProjectMock).toHaveBeenCalledWith(PROJECT.path, NATIVE_SESSION.path);
    });
    expect(importTranscriptMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed import instead of opening a broken session", async () => {
    importTranscriptMock.mockResolvedValue({ ok: false, error: "Could not read transcript" });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Could not read transcript");
    expect(bindProjectMock).not.toHaveBeenCalled();
  });

  it("stays usable after a failed import", async () => {
    importTranscriptMock.mockRejectedValue(new Error("daemon not ready"));
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));
    await screen.findByRole("alert");

    // `busy` must be released, or every later click is silently ignored.
    const row = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(row?.hasAttribute("disabled")).toBe(false);
  });

  it("explains an internal startup failure in plain words and retries the same session", async () => {
    bindProjectMock
      .mockRejectedValueOnce(new Error("pane 'primary' generation 3 was superseded"))
      .mockResolvedValueOnce(undefined);
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Couldn’t open “Native GG Coder session”. Please try again."),
    ).toBeDefined();
    // The internal cause is kept for bug reports, but only under Details.
    const detail = within(alert).getByText("pane 'primary' generation 3 was superseded");
    expect(detail.closest("details")).not.toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(bindProjectMock).toHaveBeenCalledTimes(2));
    expect(bindProjectMock).toHaveBeenLastCalledWith(PROJECT.path, NATIVE_SESSION.path);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("renders an open failure directly under the row that failed", async () => {
    const second: RecentSession = { ...NATIVE_SESSION, id: "gg-2", path: "/s/2", preview: "Two" };
    bindProjectMock.mockRejectedValueOnce(new Error("pane 'primary' generation 3 was superseded"));
    await renderSessionList([NATIVE_SESSION, second]);

    const row = screen.getByText(NATIVE_SESSION.preview).closest("button");
    fireEvent.click(row as HTMLButtonElement);

    const alert = await screen.findByRole("alert");
    expect(row?.nextElementSibling).toBe(alert);
    expect(row?.getAttribute("aria-describedby")).toBe(alert.id);
    const otherRow = screen.getByText("Two").closest("button");
    expect(otherRow?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps a new-session failure above the list", async () => {
    bindProjectMock.mockRejectedValueOnce(new Error("pane 'primary' generation 3 was superseded"));
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.parentElement?.classList.contains("picker-list")).toBe(true);
    expect(alert.textContent).toContain("Couldn’t open this session");
  });
});

describe("ProjectPicker header", () => {
  it("keeps the drag region on the wrappers and off every control", async () => {
    await renderProjectList([PROJECT]);
    const head = document.querySelector(".picker-head") as HTMLElement;
    for (const selector of [".picker-head-main", ".picker-head-window", ".picker-head-actions"]) {
      expect(head.querySelector(selector)?.hasAttribute("data-tauri-drag-region")).toBe(true);
    }
    expect(head.hasAttribute("data-tauri-drag-region")).toBe(true);
    const controls = head.querySelectorAll("button, input, select, [role='menuitem']");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
    // Window controls sit outside the page column.
    const windowControls = head.querySelector(".picker-head-window");
    expect(windowControls?.parentElement).toBe(head);
    expect(
      within(windowControls as HTMLElement).getByRole("button", { name: "Radio" }),
    ).toBeTruthy();
  });
});

describe("ProjectPicker More menu", () => {
  it("opens, runs an item, and returns focus to the trigger on Escape", async () => {
    openFolderDialogMock.mockResolvedValue(null);
    await renderProjectList([PROJECT]);

    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Add projects folder", "Open project directly"]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open project directly" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openFolderDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Open project directly" }),
    );
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ProjectPicker folder errors", () => {
  it("explains a failed folder save plainly, with Details and Retry", async () => {
    openFolderDialogMock.mockResolvedValue("/Users/workspace");
    saveSettingsMock.mockRejectedValueOnce(new Error("EACCES: settings.json"));
    await renderProjectList([PROJECT]);

    fireEvent.click(screen.getByRole("button", { name: "Add projects folder" }));

    const alert = await screen.findByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe(
      "Couldn’t add that projects folder. Please try again.",
    );
    expect(alert.querySelector("details code")?.textContent).toBe("EACCES: settings.json");

    saveSettingsMock.mockResolvedValueOnce();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(openFolderDialogMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("describeOpenFailure", () => {
  it.each([
    [
      "pane 'primary' did not start in time",
      "This session took too long to start. Please try again.",
      "pane 'primary' did not start in time",
    ],
    [
      "pane 'p2' generation 4 was superseded",
      "Couldn’t open this session. Please try again.",
      "pane 'p2' generation 4 was superseded",
    ],
    [
      "Not signed in. Run `ggcoder login` first.",
      "Couldn’t open this session: Not signed in. Use AI Providers to sign in first.",
      null,
    ],
    ["", "Couldn’t open this session. Please try again.", null],
    [
      "pane 'primary' failed to start: Not signed in. Use the Login to AI Providers button.",
      "Couldn’t open this session: Not signed in. Use the Login to AI Providers button.",
      null,
    ],
    [
      "pane 'primary' failed to start: Not signed in. Run `ggcoder login`\nthen retry.",
      "Couldn’t open this session: Not signed in. Use AI Providers to sign in\nthen retry.",
      null,
    ],
    [
      "pane 'p2' failed to start: unknown error",
      "Couldn’t open this session. Please try again.",
      "pane 'p2' failed to start: unknown error",
    ],
    [
      "pane 'primary' generation 2 was superseded during startup",
      "Couldn’t open this session. Please try again.",
      "pane 'primary' generation 2 was superseded during startup",
    ],
    [
      "pane 'primary' failed to start: pane 'primary' generation 2 was superseded during startup",
      "Couldn’t open this session. Please try again.",
      "pane 'primary' failed to start: pane 'primary' generation 2 was superseded during startup",
    ],
    [
      "pane 'chat' generation 42 startup ended without settlement",
      "Couldn’t open this session. Please try again.",
      "pane 'chat' generation 42 startup ended without settlement",
    ],
    [
      "pane 'p3' does not exist",
      "Couldn’t open this session. Please try again.",
      "pane 'p3' does not exist",
    ],
    [
      "pane 'p3' generation is stale",
      "Couldn’t open this session. Please try again.",
      "pane 'p3' generation is stale",
    ],
    [
      "failed to listen for pane 'p4' readiness: Error: denied",
      "Couldn’t open this session. Please try again.",
      "failed to listen for pane 'p4' readiness: Error: denied",
    ],
  ])("maps %j", (message, summary, detail) => {
    expect(describeOpenFailure(message)).toEqual({ summary, detail });
  });
});
