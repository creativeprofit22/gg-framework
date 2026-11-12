// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NotesRoadmapEvent } from "../notes-types";
import { renderRoadmap, roadmapPhase } from "../test-support/notes-roadmap-harness";
import { waitingOnLabel } from "./roadmap-dependency-presentation";

afterEach(cleanup);

function phases() {
  return [
    roadmapPhase("api", "Build API", "in-progress"),
    roadmapPhase("schema", "Design schema", "done"),
    roadmapPhase("docs", "Write docs", "not-started"),
    roadmapPhase("ui", "Ship UI", "not-started", { dependsOn: ["api", "schema"] }),
  ];
}

function detail(): HTMLElement {
  return document.querySelector<HTMLElement>(".notes-phase-detail")!;
}

describe("Waiting on", () => {
  it("shows unfinished prerequisites on the card and in the detail overview", () => {
    renderRoadmap(phases());
    const card = screen
      .getByRole("button", { name: "Inspect phase: Ship UI" })
      .closest<HTMLElement>("li")!;
    expect(within(card).getByText("Waiting on: Build API")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    expect(within(detail()).getByText("Waiting on: Build API")).toBeTruthy();
  });

  it("is hidden when every prerequisite is Done and summarises long lists", () => {
    renderRoadmap([
      roadmapPhase("schema", "Design schema", "done"),
      roadmapPhase("ui", "Ship UI", "not-started", { dependsOn: ["schema"] }),
    ]);
    expect(screen.queryByText(/^Waiting on:/)).toBeNull();
    expect(waitingOnLabel([{ title: "A" }, { title: "B" }, { title: "C" }])).toBe(
      "Waiting on: A, B and C",
    );
    expect(waitingOnLabel([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }])).toBe(
      "Waiting on: A, B and 2 more",
    );
  });
});

describe("Depends on list and editing", () => {
  it("lists every dependency with its status in the detail", () => {
    renderRoadmap(phases());
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    const list = within(detail()).getByRole("region", { name: "Depends on" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Build APIIn progress",
      "Design schemaDone",
    ]);
  });

  it("adds and removes prerequisites and saves the new list", () => {
    const { props } = renderRoadmap(phases());
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    fireEvent.click(within(detail()).getByRole("button", { name: "Edit" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove prerequisite: Design schema" }));
    const select = screen.getByLabelText("Add a prerequisite");
    fireEvent.change(select, { target: { value: "docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      within(screen.getByRole("list", { name: "Prerequisite phases" }))
        .getAllByRole("listitem")
        .map((item) => item.firstElementChild?.textContent),
    ).toEqual(["Build API · In progress", "Write docs · Not started"]);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onEditPhase).toHaveBeenCalledExactlyOnceWith("ui", {
      title: "Ship UI",
      goal: "Goal for Ship UI",
      doneWhen: ["It works"],
      dependsOn: ["api", "docs"],
    });
  });

  it("shows the shared validation error for a cycle and blocks Save", () => {
    const { props } = renderRoadmap([
      roadmapPhase("api", "Build API", "in-progress", { dependsOn: ["ui"] }),
      roadmapPhase("ui", "Ship UI", "not-started"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    fireEvent.click(within(detail()).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Add a prerequisite"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("alert").textContent).toMatch(/cycle|circular|depend/i);
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(props.onEditPhase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove prerequisite: Build API" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  });
});

describe("dependency override history", () => {
  it("names the prerequisites the user started past", () => {
    const override: NotesRoadmapEvent = {
      type: "dependency-override",
      id: "override-1",
      actor: "user",
      origin: "app",
      session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
      unfinishedPrerequisiteIds: ["api", "gone"],
      timestamp: "2026-07-15T12:30:00.000Z",
    };
    renderRoadmap([
      roadmapPhase("api", "Build API", "in-progress"),
      roadmapPhase("ui", "Ship UI", "in-progress", {
        dependsOn: ["api"],
        roadmapEvents: [override],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Ship UI" }));
    const activityTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((tab) => tab.textContent === "Activity")!;
    fireEvent.click(activityTab);
    expect(
      screen.getByText("Started before these prerequisites were Done: Build API, Missing phase."),
    ).toBeTruthy();
  });
});
