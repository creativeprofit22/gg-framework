// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KenPromptActionProvider, Markdown } from "./Markdown";
import { sendPrompt } from "./agent";
import type {
  KenPromptAction,
  KenPromptActionDispatcher,
  KenPromptActionResult,
} from "./ken-prompt-actions";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

afterEach(() => cleanup());

function promptMarkdown(prompt = "Implement the exact prompt\n  Keep indentation"): string {
  return `\`\`\`prompt\n${prompt}\n\`\`\``;
}

function renderPrompt(dispatch: (action: KenPromptAction) => Promise<KenPromptActionResult>) {
  const dispatcher: KenPromptActionDispatcher = { dispatch };
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
  it("hides prompt actions without a typed dispatcher and never uses the global sender", () => {
    render(<Markdown>{promptMarkdown()}</Markdown>);

    expect(document.querySelector(".ken-prompt-body")?.textContent).toContain(
      "Implement the exact prompt",
    );
    expect(screen.queryByRole("button", { name: /Send to .* Coder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More prompt actions" })).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("sends the normalized prompt through the typed primary action once", async () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: /Send to .* Coder/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sent" }).hasAttribute("disabled")).toBe(true),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "send-current",
      prompt: "Implement the exact prompt\n  Keep indentation",
    });
  });

  it("opens with More, previews exact content, validates, and returns focus on Escape", async () => {
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
      return { status: "sent", session: "current" };
    });
    const { container } = renderPrompt(dispatch);
    const more = screen.getByRole("button", { name: "More prompt actions" });

    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));
    expect(await screen.findByText("Prompt preview")).toBeTruthy();
    expect(container.querySelector(".ken-prompt-preview pre")?.textContent).toBe(
      "Implement the exact prompt\n  Keep indentation",
    );

    fireEvent.change(screen.getByLabelText("Draft title"), { target: { value: " " } });
    fireEvent.submit(screen.getByRole("button", { name: "Save prompt" }).closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("Enter a title");

    fireEvent.click(screen.getByLabelText("Existing phase"));
    expect(screen.getByText(/replaces the prompt currently saved/)).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Phase destination"), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(more));
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("locks conflicting controls while pending and keeps a transport failure retryable", async () => {
    const pending = deferred<KenPromptActionResult>();
    const dispatch = vi.fn((action: KenPromptAction) => {
      if (action.type === "send-fresh") return pending.promise;
      return Promise.resolve({ status: "sent", session: "current" } as const);
    });
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    fireEvent.click(screen.getByRole("button", { name: "New session + send" }));
    expect(screen.getByRole("status").textContent).toBe("Creating session…");
    expect(screen.getByRole("button", { name: /Send to .* Coder/ }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "More prompt actions" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      pending.resolve({
        status: "failed",
        action: "send-fresh",
        message: "Couldn’t confirm the new session. Try again.",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t confirm");
    expect(
      screen.getByRole("button", { name: "New session + send" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps an oversized Notes save preview retryable with shortening guidance", async () => {
    const guidance =
      "Project Notes is too large to save. Shorten the saved prompt or Notes document, then try again.";
    const dispatch = vi.fn(async (action: KenPromptAction): Promise<KenPromptActionResult> => {
      if (action.type === "prepare-save") {
        return {
          status: "preview",
          preview: {
            prompt: action.prompt,
            suggestedTitle: "Implement the exact prompt",
            destinations: [],
          },
        };
      }
      if (action.type === "commit-save") {
        return { status: "failed", action: "commit-save", message: guidance };
      }
      return { status: "sent", session: "current" };
    });
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));
    const save = await screen.findByRole("button", { name: "Save prompt" });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain(guidance);
    expect(screen.getByText("Prompt preview")).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(dispatch.mock.calls.filter(([action]) => action.type === "commit-save")).toHaveLength(
        2,
      ),
    );
  });

  it("announces Autopilot auto-accept save without opening the manual form", async () => {
    const dispatch = vi.fn(
      async (action: KenPromptAction): Promise<KenPromptActionResult> =>
        action.type === "prepare-save"
          ? { status: "saved", phaseId: "draft-1", title: "Implement the exact prompt" }
          : { status: "sent", session: "current" },
    );
    renderPrompt(dispatch);

    fireEvent.click(screen.getByRole("button", { name: "More prompt actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Saved to Notes: Implement the exact prompt",
      ),
    );
    expect(screen.queryByText("Save prompt to Project Notes")).toBeNull();
  });
});
