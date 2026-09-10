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
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

describe("Markdown links", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    ["E:/Projects/README.md", "E:/Projects/README.md"],
    ["E:\\Projects\\README.md", "E:/Projects/README.md"],
    ["file:///E:/Projects/my%20file.md#L12", "E:/Projects/my file.md"],
    ["docs/report%23Log.md", "docs/report#Log.md"],
    ["docs/report%23L12.md", "docs/report#L12.md"],
    ["project%2520copy/image.png", "project%20copy/image.png"],
    ["my%20file.md", "my file.md"],
    ["README.md#installation", "README.md"],
    ["README.md?view=1#L12", "README.md"],
    ["file:///tmp/readme.md", "/tmp/readme.md"],
    ["file://localhost/E:/Projects/README.md", "E:/Projects/README.md"],
    ["src/App.tsx", "src/App.tsx"],
    ["Dockerfile:12", "./Dockerfile"],
    ["Makefile:12:3", "./Makefile"],
    ["LICENSE:1", "./LICENSE"],
    ["./Dockerfile:12", "./Dockerfile"],
    ["./Makefile:12:3", "./Makefile"],
    ["./LICENSE:1", "./LICENSE"],
    ["src/Dockerfile:12", "src/Dockerfile"],
    ["README.md:12", "./README.md"],
    ["./README.md:12:3", "./README.md"],
    ["README.md:12:3", "./README.md"],
    ["src/App.tsx:12", "src/App.tsx"],
  ])("opens local destination %s", async (destination, expected) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const openProjectPath = vi.spyOn(await import("./agent"), "openProjectPath");
    render(<Markdown>{`[file](${destination})`}</Markdown>);
    const link = screen.getByRole("link");
    if (/^[^:/]+:\d+(?::\d+)?$/.test(destination)) {
      expect(link.getAttribute("href")).toBe(`./${destination}`);
    }
    fireEvent.click(link);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_project_path", {
        paneId: "primary",
        path: expected,
      }),
    );
    expect(openProjectPath).toHaveBeenCalledExactlyOnceWith(
      link.getAttribute("href"),
      "primary",
      "url",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/plain,hello",
    "vbscript:msgbox(1)",
    "javascript:12",
    "JaVaScRiPt:12:3",
    "data:12:3",
    "vbscript:12",
    "file:12",
    "blob:12",
    "about:12",
    "ftp:12",
    "tel:12",
    "sms:12",
    "unknown:payload",
    "Dockerfile:abc",
    "Dockerfile:12:3:4",
    "file://server/share/file.md",
  ])("does not open blocked destination %s", async (destination) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    render(<Markdown>{`[blocked](${destination})`}</Markdown>);
    const link = screen.getByText("blocked");
    expect(link.getAttribute("href")).toBe("");
    fireEvent.click(link);
    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    "file:///E:/image.png",
    "E:/image.png",
    "README.md:12",
    "Dockerfile:12",
    "Makefile:12:3",
    "LICENSE:1",
    "javascript:12",
    "data:12",
  ])("keeps image exception %s blocked", (destination) => {
    render(<Markdown>{`![local](${destination})`}</Markdown>);
    expect(screen.getByRole("img").getAttribute("src")).toBeFalsy();
  });

  it.each([
    "https://example.com",
    "http://example.com",
    "mailto:person@example.com",
    "https:12",
    "mailto:12",
  ])("preserves external destination %s", async (destination) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    render(<Markdown>{`[external](${destination})`}</Markdown>);
    fireEvent.click(screen.getByRole("link"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(destination));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens web links and reports opening errors", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const { toast } = await import("./toast");
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("No application"));
    render(<Markdown>{"[web](https://example.com)"}</Markdown>);
    fireEvent.click(screen.getByRole("link"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Could not open link: Error: No application", "error"),
    );
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });
});

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function mockClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

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
  it("copies each complete source body independently and waits for clipboard success", async () => {
    const pending = deferred<void>();
    const write = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    mockClipboard(write);
    const dispatch = vi.fn();
    const first = "  Keep indentation\n\n  Unicode 日本語 café\n" + "Long content ".repeat(400);
    const second = "Second prompt\n    Different body";
    render(
      <KenPromptActionProvider value={{ dispatch, blockedReason: () => "Blocked" }}>
        <Markdown>{`Surrounding prose\n\n${promptMarkdown(first)}\n\n${promptMarkdown(second)}`}</Markdown>
      </KenPromptActionProvider>,
    );
    const copies = screen.getAllByRole("button", { name: "Copy prompt" });
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.textContent).toBe("");
      expect(copy.title).toBe("Copy prompt");
      expect(copy.previousElementSibling?.textContent).toBe("Save to Notes");
    }
    fireEvent.click(copies[0]);
    expect(write).toHaveBeenCalledWith(first);
    expect(screen.queryByText("Prompt copied.")).toBeNull();
    expect(screen.getByRole("button", { name: "Copying prompt…" })).toMatchObject({
      disabled: true,
      title: "Copying prompt…",
    });
    fireEvent.click(copies[0]);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    expect(screen.getByRole("status").textContent).toBe("Prompt copied.");
    fireEvent.click(copies[1]);
    await waitFor(() => expect(screen.getAllByText("Prompt copied.")).toHaveLength(2));
    expect(write).toHaveBeenLastCalledWith(second);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves literal backslash-n text and real newlines when rendering and copying a Ken prompt", async () => {
    const body = '  Keep literal \\n text and "\\n" unchanged\n\n    Real newline: 日本語 café';
    const write = vi.fn().mockResolvedValue(undefined);
    mockClipboard(write);
    const dispatch = vi.fn();
    const { container } = render(
      <KenPromptActionProvider value={{ dispatch }}>
        <Markdown>{promptMarkdown(body)}</Markdown>
      </KenPromptActionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await screen.findByText("Prompt copied.");
    expect.soft(container.querySelector(".ken-prompt-body")?.textContent).toBe(body);
    expect(write).toHaveBeenCalledExactlyOnceWith(body);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches exact selected source for a fresh session without trimming whitespace", async () => {
    const bodies = [
      "  Keep literal \\n and café 日本語\n\n    Trailing spaces  \n",
      "  CRLF 🙂\r\n\tkeep outer whitespace  \r\n",
      "Second independent block",
    ];
    const dispatch = vi.fn(async () => ({ status: "cancelled" }) as const);
    render(
      <KenPromptActionProvider value={{ dispatch }}>
        <Markdown>{bodies.map((body) => promptMarkdown(body)).join("\n\n")}</Markdown>
      </KenPromptActionProvider>,
    );
    const actions = screen.getAllByRole("button", { name: "New session" });
    for (const [index, body] of bodies.entries()) {
      await act(async () => fireEvent.click(actions[index]));
      expect(dispatch).toHaveBeenNthCalledWith(index + 1, { type: "send-fresh", prompt: body });
    }
  });

  it.each(["rejection", "missing", "throw"])(
    "reports clipboard %s independently and retries through Copy",
    async (failure) => {
      mockClipboard(
        failure === "missing"
          ? undefined
          : () => {
              if (failure === "throw") throw new Error("denied");
              return Promise.reject(new Error("denied"));
            },
      );
      const dispatch = vi.fn(
        async () =>
          ({ status: "failed", action: "send-fresh", message: "Destination failed." }) as const,
      );
      renderPrompt(dispatch);
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await screen.findByText("Destination failed.");
      fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
      await screen.findByText(
        "Could not copy prompt. Try Copy again or select the prompt text manually.",
      );
      expect(screen.getAllByRole("alert")).toHaveLength(2);
      expect(screen.queryByText("Prompt copied.")).toBeNull();
      mockClipboard(vi.fn().mockResolvedValue(undefined));
      fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
      await screen.findByText("Prompt copied.");
      expect(screen.getByRole("alert").textContent).toContain("Destination failed.");
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("withholds controls until the prompt fence is complete", () => {
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    const dispatcher: KenPromptActionDispatcher = { dispatch };
    const { rerender } = render(
      <KenPromptActionProvider value={dispatcher}>
        <Markdown>{"```prompt\nStill streaming"}</Markdown>
      </KenPromptActionProvider>,
    );

    expect(screen.queryByRole("button", { name: "Continue here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();

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

  it.each([
    ["inline backticks", "```prompt\nStill streaming ```", "Still streaming ```", "```"],
    ["shorter fence", "````prompt\nStill streaming\n```", "Still streaming\n```", "````"],
    ["indented fence", "```prompt\nStill streaming\n    ```", "Still streaming\n    ```", "```"],
    ["trailing text", "```prompt\nStill streaming\n``` more", "Still streaming\n``` more", "```"],
  ])(
    "withholds every action for %s until an explicit closing fence arrives",
    async (_, partial, body, closing) => {
      const write = vi.fn().mockResolvedValue(undefined);
      mockClipboard(write);
      const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
      const dispatcher: KenPromptActionDispatcher = { dispatch };
      const { rerender } = render(
        <KenPromptActionProvider value={dispatcher}>
          <Markdown>{partial}</Markdown>
        </KenPromptActionProvider>,
      );
      const actions = ["Continue here", "New session", "Save to Notes", "Copy prompt"];
      for (const name of actions) expect(screen.queryByRole("button", { name })).toBeNull();
      expect(write).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      rerender(
        <KenPromptActionProvider value={dispatcher}>
          <Markdown>{`${partial}\n${closing}`}</Markdown>
        </KenPromptActionProvider>,
      );
      for (const name of actions) expect(screen.getByRole("button", { name })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
      await screen.findByText("Prompt copied.");
      expect(write).toHaveBeenCalledExactlyOnceWith(body);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["matching longer fence", "````prompt", "````"],
    ["longer closing fence", "```prompt", "`````"],
    ["allowed indentation and whitespace", "   ```prompt", "   ``` \t"],
  ])("keeps actions ready after a %s while later text streams", async (_, opening, closing) => {
    const write = vi.fn().mockResolvedValue(undefined);
    mockClipboard(write);
    const dispatch = vi.fn(async () => ({ status: "sent", session: "current" }) as const);
    const dispatcher: KenPromptActionDispatcher = { dispatch };
    const complete = `${opening}\nComplete 日本語\n${closing}\n\n`;
    const { rerender } = render(
      <KenPromptActionProvider value={dispatcher}>
        <Markdown>{`${complete}Ongoing prose`}</Markdown>
      </KenPromptActionProvider>,
    );
    for (const tail of [
      "Ongoing prose continues",
      "Ongoing prose continues\n\n```prompt\nStill streaming ```",
    ]) {
      for (const name of ["Continue here", "New session", "Save to Notes", "Copy prompt"]) {
        expect(screen.getAllByRole("button", { name })).toHaveLength(1);
      }
      rerender(
        <KenPromptActionProvider value={dispatcher}>
          <Markdown>{complete + tail}</Markdown>
        </KenPromptActionProvider>,
      );
    }
    for (const name of ["Continue here", "New session", "Save to Notes", "Copy prompt"]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await screen.findByText("Prompt copied.");
    expect(write).toHaveBeenCalledExactlyOnceWith("Complete 日本語");
    expect(dispatch).not.toHaveBeenCalled();
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
      "",
    ]);
    expect(actions[3]?.getAttribute("aria-label")).toBe("Copy prompt");
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
