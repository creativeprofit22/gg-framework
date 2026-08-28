// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNotesStorageDiagnostics } from "../notes-types";
import { NotesStorageDiagnostics } from "./NotesPhaseMoreView";

const writeText = vi.fn(async () => undefined);
const diagnostics: ProjectNotesStorageDiagnostics = {
  version: 1,
  applicationIdentity: "com.ggcoder.local-fork",
  daemonOwner: "node-sidecar",
  agentDataRoot: "C:\\agent",
  canonicalCwd: "c:/work/project",
  projectKey: "c:/work/project",
  projectNotesStore: {
    primaryPath: "C:\\agent\\project-notes\\project.json",
    backupPath: "C:\\agent\\project-notes\\project.backup.json",
  },
  logicalSessionId: "logical-current",
  currentSession: { sessionId: "session-current", sessionPath: null },
  activePhaseContext: {
    phaseId: "phase-1",
    projectKey: "c:/work/project",
    session: { sessionId: "session-current", sessionPath: null },
  },
  persistedPhaseBinding: {
    phaseId: "phase-1",
    projectKey: "c:/work/project",
    session: { sessionId: "session-other", sessionPath: "C:\\sessions\\other.jsonl" },
  },
  consistency: "bound-to-other-session",
};

describe("Roadmap storage diagnostics", () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(cleanup);

  it("distinguishes a phase bound to another session", async () => {
    render(<NotesStorageDiagnostics phaseId="phase-1" onLoad={async () => diagnostics} />);

    expect(await screen.findByText("Bound elsewhere")).toBeTruthy();
    expect(screen.getByText("This phase belongs to another session. Resume that session instead.")).toBeTruthy();
    expect(screen.getByText("session-other")).toBeTruthy();
    expect(screen.getByText("com.ggcoder.local-fork")).toBeTruthy();
  });

  it("shows wrong-store failures separately and copies non-secret fields", async () => {
    render(
      <NotesStorageDiagnostics
        phaseId="phase-1"
        onLoad={async () => ({ ...diagnostics, consistency: "store-unavailable" })}
      />,
    );

    expect(await screen.findByText("Store unavailable")).toBeTruthy();
    const application = screen.getByText("com.ggcoder.local-fork").closest("div");
    fireEvent.click(application!.querySelector("button")!);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("com.ggcoder.local-fork"),
    );
    expect(screen.getByRole("status").textContent).toBe("Application copied.");
  });

  it("keeps daemon errors typed and local", async () => {
    render(
      <NotesStorageDiagnostics
        phaseId="phase-1"
        onLoad={async () => {
          throw new Error("Diagnostics unavailable");
        }}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Diagnostics unavailable");
  });
});
