// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredProject, RecentSession } from "./agent";
import { ProjectPicker } from "./ProjectPicker";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve(null)),
  toast: vi.fn(),
}));

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  getSettings: mocks.getSettings,
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  selectProject: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: mocks.toast }));
vi.mock("./build-info", () => ({
  formatBuildIdentity: () => "GG Coder Local Fork · abc1234",
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({
  WindowLayoutButton: () => <button>Windows</button>,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const projects: DiscoveredProject[] = [
  { name: "Alpha", path: "/alpha", lastActiveDisplay: "now", sources: ["ggcoder"] },
  { name: "Beta", path: "/beta", lastActiveDisplay: "now", sources: ["ggcoder"] },
];

function session(id: string): RecentSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    preview: `${id} session`,
    lastActiveDisplay: "now",
    messageCount: 1,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectPicker", () => {
  it("renders the local-build identity in the picker header", () => {
    render(
      <ProjectPicker
        onChosen={vi.fn()}
        waitForCatalogReady={() => new Promise(() => {})}
        showWindowControls={false}
      />,
    );

    const identity = screen.getByText("GG Coder Local Fork · abc1234");
    expect(identity.className).toBe("picker-build-identity");
    expect(identity.getAttribute("title")).toBe("GG Coder Local Fork · abc1234");
  });

  it("ignores a stale session response after another project is selected", async () => {
    const alphaSessions = deferred<RecentSession[]>();
    const betaSessions = deferred<RecentSession[]>();
    const discoverSessions = vi.fn((cwd: string) =>
      cwd === "/alpha" ? alphaSessions.promise : betaSessions.promise,
    );

    render(
      <ProjectPicker
        onChosen={vi.fn()}
        waitForCatalogReady={() => Promise.resolve()}
        discoverProjects={() => Promise.resolve(projects)}
        discoverSessions={discoverSessions}
        bindProject={() => Promise.resolve()}
        showWindowControls={false}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));

    betaSessions.resolve([session("beta")]);
    expect(await screen.findByText("beta session")).toBeDefined();

    alphaSessions.resolve([session("alpha")]);
    await waitFor(() => expect(screen.queryByText("alpha session")).toBeNull());
    expect(screen.getByText("beta session")).toBeDefined();
  });

  it("reports pane-scoped startup failures instead of silently emptying the picker", async () => {
    render(
      <ProjectPicker
        onChosen={vi.fn()}
        waitForCatalogReady={() => Promise.reject(new Error("secondary pane unavailable"))}
        discoverProjects={() => Promise.resolve(projects)}
        showWindowControls={false}
      />,
    );

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        "Agent failed to start: secondary pane unavailable",
        "error",
      );
    });
  });
});
