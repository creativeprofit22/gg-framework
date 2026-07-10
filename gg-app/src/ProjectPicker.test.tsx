// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "./ProjectPicker";
import type { DiscoveredProject, RecentSession } from "./agent";

const { openFolderDialog, primarySelectProject } = vi.hoisted(() => ({
  openFolderDialog: vi.fn(),
  primarySelectProject: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFolderDialog }));
vi.mock("./agent", () => ({
  waitForReady: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  selectProject: primarySelectProject,
  getSettings: vi.fn().mockResolvedValue({ projectsRoot: "/projects" }),
  focusWindowByOffset: vi.fn(),
  arrangeAllWindows: vi.fn(),
  createProject: vi.fn(async (name: string) => `/projects/${name}`),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => null }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => null }));

const PROJECT: DiscoveredProject = {
  name: "Exact project",
  path: "/work/exact-project",
  lastActiveDisplay: "now",
  sources: ["ggcoder"],
};
const SECOND_PROJECT: DiscoveredProject = {
  name: "Second project",
  path: "/work/second-project",
  lastActiveDisplay: "later",
  sources: ["ggcoder"],
};
const SESSION: RecentSession = {
  id: "session-1",
  path: "/sessions/exact-session.jsonl",
  preview: "Continue exact work",
  lastActiveDisplay: "now",
  messageCount: 4,
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ProjectPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openFolderDialog.mockResolvedValue(null);
    primarySelectProject.mockResolvedValue(undefined);
  });

  it("waits for supplied readiness, then uses supplied project and session discovery", async () => {
    const ready = deferred<void>();
    const waitForCatalogReady = vi.fn(() => ready.promise);
    const discoverProjects = vi.fn().mockResolvedValue([PROJECT]);
    const discoverSessions = vi.fn().mockResolvedValue([SESSION]);

    render(
      <ProjectPicker
        onChosen={() => undefined}
        waitForCatalogReady={waitForCatalogReady}
        discoverProjects={discoverProjects}
        discoverSessions={discoverSessions}
      />,
    );

    expect(waitForCatalogReady).toHaveBeenCalledTimes(1);
    expect(discoverProjects).not.toHaveBeenCalled();
    ready.resolve();
    expect(await screen.findByRole("button", { name: /Exact project/ })).toBeTruthy();
    expect(discoverProjects).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Exact project/ }));
    expect(discoverSessions).toHaveBeenCalledWith("/work/exact-project");
    expect(await screen.findByRole("button", { name: /Continue exact work/ })).toBeTruthy();
  });

  it("ignores a stale session response after another project is selected", async () => {
    const firstSessions = deferred<RecentSession[]>();
    const secondSessions = deferred<RecentSession[]>();
    const discoverSessions = vi.fn((cwd: string) =>
      cwd === PROJECT.path ? firstSessions.promise : secondSessions.promise,
    );
    const secondSession = {
      ...SESSION,
      id: "session-2",
      path: "/sessions/second.jsonl",
      preview: "Second project session",
    };

    render(
      <ProjectPicker
        onChosen={() => undefined}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve([PROJECT, SECOND_PROJECT])}
        discoverSessions={discoverSessions}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Exact project/ }));
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(screen.getByRole("button", { name: /Second project/ }));
    secondSessions.resolve([secondSession]);
    expect(await screen.findByRole("button", { name: /Second project session/ })).toBeTruthy();

    firstSessions.resolve([SESSION]);
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /Continue exact work/ })).toBeNull();
  });

  it("binds the exact project cwd and existing session path", async () => {
    const bindProject = vi.fn().mockResolvedValue(undefined);
    const onChosen = vi.fn();
    render(
      <ProjectPicker
        onChosen={onChosen}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve([PROJECT])}
        discoverSessions={() => Promise.resolve([SESSION])}
        bindProject={bindProject}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Exact project/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue exact work/ }));

    await waitFor(() =>
      expect(bindProject).toHaveBeenCalledWith(
        "/work/exact-project",
        "/sessions/exact-session.jsonl",
      ),
    );
    expect(onChosen).toHaveBeenCalledWith("/work/exact-project");
    expect(primarySelectProject).not.toHaveBeenCalled();
  });

  it("binds a new session to the exact project cwd without a session path", async () => {
    const bindProject = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectPicker
        onChosen={() => undefined}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve([PROJECT])}
        discoverSessions={() => Promise.resolve([SESSION])}
        bindProject={bindProject}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Exact project/ }));
    await screen.findByRole("button", { name: /Continue exact work/ });
    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));

    await waitFor(() => expect(bindProject).toHaveBeenCalledWith("/work/exact-project", undefined));
    expect(primarySelectProject).not.toHaveBeenCalled();
  });

  it("keeps an open-existing choice on the injected binder", async () => {
    const bindProject = vi.fn().mockResolvedValue(undefined);
    openFolderDialog.mockResolvedValueOnce("/picked/existing");
    render(
      <ProjectPicker
        onChosen={() => undefined}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve([PROJECT])}
        discoverSessions={() => Promise.resolve([])}
        bindProject={bindProject}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open existing" }));

    await waitFor(() => expect(bindProject).toHaveBeenCalledWith("/picked/existing", undefined));
    expect(primarySelectProject).not.toHaveBeenCalled();
  });

  it("keeps a later new-project choice on the injected binder", async () => {
    const bindProject = vi.fn().mockResolvedValue(undefined);
    const onChosen = vi.fn();
    render(
      <ProjectPicker
        onChosen={onChosen}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve([PROJECT])}
        discoverSessions={() => Promise.resolve([])}
        bindProject={bindProject}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "+ New project" }));
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "Later Choice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(bindProject).toHaveBeenCalledWith("/projects/later-choice"));
    expect(onChosen).toHaveBeenCalledWith("/projects/later-choice");
    expect(primarySelectProject).not.toHaveBeenCalled();
  });
});
