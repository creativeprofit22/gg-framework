// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectModal } from "./NewProjectModal";

const { primarySelectProject } = vi.hoisted(() => ({ primarySelectProject: vi.fn() }));

vi.mock("./agent", () => ({
  createProject: vi.fn(),
  selectProject: primarySelectProject,
}));

describe("NewProjectModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primarySelectProject.mockResolvedValue(undefined);
  });

  it("delegates slugged folder creation and binds the returned cwd", async () => {
    const createFolder = vi.fn().mockResolvedValue("/projects/my-new-project");
    const bindProject = vi.fn().mockResolvedValue(undefined);
    const onCreated = vi.fn();

    render(
      <NewProjectModal
        projectsRoot="/projects"
        onClose={() => undefined}
        onCreated={onCreated}
        createFolder={createFolder}
        bindProject={bindProject}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "My New Project!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith("my-new-project"));
    expect(bindProject).toHaveBeenCalledWith("/projects/my-new-project");
    expect(onCreated).toHaveBeenCalledWith("/projects/my-new-project");
    expect(primarySelectProject).not.toHaveBeenCalled();
  });

  it("does not bind or complete when delegated folder creation fails", async () => {
    const createFolder = vi.fn().mockRejectedValue(new Error("folder exists"));
    const bindProject = vi.fn();
    const onCreated = vi.fn();

    render(
      <NewProjectModal
        projectsRoot="/projects"
        onClose={() => undefined}
        onCreated={onCreated}
        createFolder={createFolder}
        bindProject={bindProject}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "Taken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("folder exists")).toBeTruthy();
    expect(bindProject).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(primarySelectProject).not.toHaveBeenCalled();
  });
});
