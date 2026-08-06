// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KenPromptActionProvider, Markdown } from "./Markdown";
import type {
  KenPromptAction,
  KenPromptActionDispatcher,
  KenPromptActionResult,
} from "./ken-prompt-actions";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn() }));

afterEach(() => cleanup());

function promptMarkdown(prompt = "  Implement the exact prompt\r\n  Keep indentation  "): string {
  return `\`\`\`prompt\n${prompt}\n\`\`\``;
}

function renderPrompt(
  dispatch: (action: KenPromptAction) => Promise<KenPromptActionResult>,
  blockedReason?: KenPromptActionDispatcher["blockedReason"],
) {
  const dispatcher: KenPromptActionDispatcher = { dispatch, blockedReason };
  return render(
    <KenPromptActionProvider value={dispatcher}>
      <Markdown>{promptMarkdown()}</Markdown>
    </KenPromptActionProvider>,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Ken prompt actions", () => {
  it("withholds controls until the prompt fence is complete", () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    const dispatcher: KenPromptActionDispatcher = { dispatch };
    const { rerender } = render(
      <KenPromptActionProvider value={dispatcher}>
        <Markdown>{"```prompt\nStill streaming"}</Markdown>
      </KenPromptActionProvider>,
    );

    expect(screen.queryByRole("button", { name: "Continue here" })).toBeNull();

    rerender(
      <KenPromptActionProvider value={dispatcher}>
        <Markdown>{"```prompt\nStill streaming\n```"}</Markdown>
      </KenPromptActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Continue here" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save to Notes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("continues with the one normalized prompt while leaving unrelated actions available", async () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Continued" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "send-current",
      prompt: "Implement the exact prompt\n  Keep indentation",
    });
    expect(
      (screen.getByRole("button", { name: "New session" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Save to Notes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Continued here.");
  });

  it("shows all actions in keyboard order, with Continue here primary", () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "fresh" }) as const);
    const { container } = renderPrompt(dispatch);
    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ken-prompt-actions button"),
    );

    expect(actions.map((button) => button.textContent)).toEqual([
      "Continue here",
      "New session",
      "Save to Notes",
    ]);
    expect(actions[0]?.classList.contains("ken-prompt-send")).toBe(true);
    expect(actions[1]?.classList.contains("ken-prompt-action")).toBe(true);
    expect(actions[2]?.classList.contains("ken-prompt-action")).toBe(true);
  });

  it("closes the save editor on Escape and returns focus to Save to Notes", async () => {
    const dispatch = vi.fn(
      async (action: KenPromptAction): Promise<KenPromptActionResult> =>
        action.type === "prepare-save"
          ? {
              status: "preview",
              preview: { prompt: action.prompt, suggestedTitle: "Draft", destinations: [] },
            }
          : { status: "sent", session: "current" },
    );
    renderPrompt(dispatch);
    const save = screen.getByRole("button", { name: "Save to Notes" });

    fireEvent.click(save);
    const title = await screen.findByLabelText("Draft title");
    expect(save.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(title, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(save));
    expect(screen.queryByLabelText("Draft title")).toBeNull();
    expect(save.getAttribute("aria-expanded")).toBe("false");
  });

  it("previews new and existing Notes destinations and commits exact guarded text", async () => {
    const dispatch = vi.fn(async (action: KenPromptAction): Promise<KenPromptActionResult> => {
      if (action.type === "prepare-save") {
        return {
          status: "preview",
          preview: {
            prompt: action.prompt,
            suggestedTitle: "Implement the exact prompt",
            destinations: [
              { phaseId: "phase-1", title: "Existing phase", sourcePrompt: "Older prompt" },
            ],
          },
        };
      }
      if (action.type === "commit-save") {
        return { status: "saved", phaseId: "phase-1", title: "Existing phase" };
      }
      return { status: "sent", session: "current" };
    });
    const { container } = renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));

    expect(await screen.findByText("New draft: Implement the exact prompt")).toBeTruthy();
    expect(container.querySelector(".ken-prompt-preview pre")?.textContent).toBe(
      "Implement the exact prompt\n  Keep indentation",
    );

    fireEvent.click(screen.getByLabelText("Existing phase"));
    expect(screen.getByText("Phase: Existing phase")).toBeTruthy();
    expect(screen.getByText(/replaces the prompt currently saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace saved prompt" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved to Existing phase."),
    );
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "commit-save",
      prompt: "Implement the exact prompt\n  Keep indentation",
      target: {
        kind: "existing-phase",
        phaseId: "phase-1",
        title: "Existing phase",
        expectedSourcePrompt: "Older prompt",
      },
    });
  });

  it("validates an empty draft title, preserves the editor, and focuses the invalid field", async () => {
    const dispatch = vi.fn(
      async (action: KenPromptAction): Promise<KenPromptActionResult> =>
        action.type === "prepare-save"
          ? {
              status: "preview",
              preview: { prompt: action.prompt, suggestedTitle: "Draft", destinations: [] },
            }
          : { status: "sent", session: "current" },
    );
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));
    const title = await screen.findByLabelText("Draft title");
    fireEvent.change(title, { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(screen.getByRole("alert").textContent).toContain("Enter a title");
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(screen.getByText("Prompt preview")).toBeTruthy();
  });

  it("disables every mutation while pending and retries a focused failure", async () => {
    const firstAttempt = deferred<KenPromptActionResult>();
    const dispatch = vi
      .fn<(action: KenPromptAction) => Promise<KenPromptActionResult>>()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockResolvedValueOnce({ status: "sent", session: "fresh" });
    renderPrompt(dispatch);

    const fresh = screen.getByRole("button", { name: "New session" });
    fireEvent.click(fresh);

    expect(screen.getByRole("status").textContent).toBe("Starting a new session…");
    expect(document.querySelector(".ken-prompt-block")?.getAttribute("aria-busy")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Continue here" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "New session" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save to Notes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      firstAttempt.resolve({
        status: "failed",
        action: "send-fresh",
        message: "Couldn’t confirm the new session.",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t confirm");
    await waitFor(() => expect(document.activeElement).toBe(fresh));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toBe("Started in new session.");
  });

  it("exposes a busy reason without hiding the New session action", () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    renderPrompt(dispatch, (action) => (action === "send-fresh" ? "A run is active." : null));

    const fresh = screen.getByRole("button", { name: "New session" }) as HTMLButtonElement;
    expect(fresh.disabled).toBe(true);
    expect(fresh.title).toBe("A run is active.");
  });
});
