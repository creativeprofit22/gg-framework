// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotesRoadmapEvent, PhaseStartResult } from "../notes-types";
import { renderRoadmap, roadmapPhase } from "../test-support/notes-roadmap-harness";

afterEach(cleanup);

const DIALOG = "Start “Ship UI” before its prerequisites are Done?";

const accepted: PhaseStartResult = {
  status: "accepted",
  operationId: "operation-1",
  session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
  packageTokenCount: 10,
};

function gatedPhases() {
  return [
    roadmapPhase("api", "Build API", "in-progress"),
    roadmapPhase("docs", "Write docs", "review"),
    roadmapPhase("ui", "Ship UI", "not-started", { dependsOn: ["api"] }),
  ];
}

describe("manual Start soft gate", () => {
  it("names each unfinished prerequisite with its status and focuses Cancel", async () => {
    const { props } = renderRoadmap(gatedPhases());
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));

    const dialog = await screen.findByRole("dialog", { name: DIALOG });
    expect(within(dialog).getByText("“Build API” is In progress.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Start anyway" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(props.onStartPhase).not.toHaveBeenCalled();
  });

  it("Cancel and Escape change nothing", async () => {
    const { props } = renderRoadmap(gatedPhases());
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    await screen.findByRole("dialog", { name: DIALOG });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(props.onStartPhase).not.toHaveBeenCalled();
    expect(props.onActionSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start phase: Ship UI" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("Start anyway sends the confirmed prerequisite ids", async () => {
    const { props } = renderRoadmap(gatedPhases());
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Start anyway",
      }),
    );

    await waitFor(() =>
      expect(props.onStartPhase).toHaveBeenCalledExactlyOnceWith("ui", {
        confirmedPrerequisiteIds: ["api"],
      }),
    );
    await waitFor(() => expect(props.onActionSuccess).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks again with the daemon's list when the unfinished set changed", async () => {
    const onStartPhase = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        code: "prerequisites-confirmation-required",
        operationId: "operation-stale",
        message: "Some prerequisite phases aren't Done. Confirm to start anyway.",
        prerequisites: [
          { id: "api", title: "Build API", status: "in-progress" },
          { id: "docs", title: "Write docs", status: "review" },
        ],
      } satisfies PhaseStartResult)
      .mockResolvedValueOnce(accepted);
    const { props } = renderRoadmap(gatedPhases(), { onStartPhase });
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Start anyway",
      }),
    );

    const reasked = await screen.findByText(
      "These prerequisites changed since you confirmed. Review them again.",
    );
    const dialog = reasked.closest<HTMLElement>("[role='dialog']")!;
    expect(within(dialog).getByText("“Write docs” is In review.")).toBeTruthy();
    expect(props.onActionSuccess).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start anyway" }));

    await waitFor(() => expect(onStartPhase).toHaveBeenCalledTimes(2));
    expect(onStartPhase).toHaveBeenNthCalledWith(1, "ui", { confirmedPrerequisiteIds: ["api"] });
    expect(onStartPhase).toHaveBeenNthCalledWith(2, "ui", {
      confirmedPrerequisiteIds: ["api", "docs"],
    });
    await waitFor(() => expect(props.onActionSuccess).toHaveBeenCalledOnce());
  });

  it("starts without a dialog when every prerequisite is Done", async () => {
    const { props } = renderRoadmap([
      roadmapPhase("api", "Build API", "done"),
      roadmapPhase("ui", "Ship UI", "not-started", { dependsOn: ["api"] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    await waitFor(() => expect(props.onStartPhase).toHaveBeenCalledExactlyOnceWith("ui"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not warn again while the confirmed run's override is current", async () => {
    const override: NotesRoadmapEvent = {
      type: "dependency-override",
      id: "override-1",
      actor: "user",
      origin: "app",
      session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
      unfinishedPrerequisiteIds: ["api"],
      timestamp: "2026-07-15T12:30:00.000Z",
    };
    const { props } = renderRoadmap([
      roadmapPhase("api", "Build API", "in-progress"),
      roadmapPhase("ui", "Ship UI", "not-started", {
        dependsOn: ["api"],
        roadmapEvents: [override],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Ship UI" }));
    await waitFor(() => expect(props.onStartPhase).toHaveBeenCalledExactlyOnceWith("ui"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gates the phase detail Start button too and clears its status on Cancel", async () => {
    const { props } = renderRoadmap(gatedPhases());
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start phase" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onStartPhase).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Starting phase…")).toBeNull());
    expect(screen.getByRole("button", { name: "Start phase" })).toHaveProperty("disabled", false);
  });
});
