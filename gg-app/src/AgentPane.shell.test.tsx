// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withRealSidecar } from "../../packages/ggcoder/src/test-support/real-sidecar";
import { AgentPane } from "./AgentPane";
import {
  agentState,
  client,
  installAgentPaneHooks,
  liveEvents,
  nativeMocks,
  target,
} from "./test-support/agent-pane-harness";

// Vitest hoists vi.mock only from the test file itself; the factories live in the harness.
vi.mock("./ProgrammaticChat", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).programmaticChatModuleMock(importOriginal),
);
vi.mock("@tauri-apps/api/core", async () =>
  (await import("./test-support/agent-pane-harness")).tauriCoreModuleMock(),
);
vi.mock("@tauri-apps/api/webview", async () =>
  (await import("./test-support/agent-pane-harness")).tauriWebviewModuleMock(),
);
vi.mock("@tauri-apps/plugin-dialog", async () =>
  (await import("./test-support/agent-pane-harness")).tauriDialogModuleMock(),
);
vi.mock("@tauri-apps/api/webviewWindow", async () =>
  (await import("./test-support/agent-pane-harness")).tauriWebviewWindowModuleMock(),
);
vi.mock("./useKenMentor", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).kenMentorModuleMock(importOriginal),
);
vi.mock("./useProgress", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).progressModuleMock(importOriginal),
);
vi.mock("./useAgentEvents", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).agentEventsModuleMock(importOriginal),
);
vi.mock("./HomeScreen", async () =>
  (await import("./test-support/agent-pane-harness")).homeScreenModuleMock(),
);
vi.mock("./SettingsScreen", async () =>
  (await import("./test-support/agent-pane-harness")).settingsScreenModuleMock(),
);
vi.mock("./ProjectPicker", async () =>
  (await import("./test-support/agent-pane-harness")).projectPickerModuleMock(),
);
vi.mock("./update", async () =>
  (await import("./test-support/agent-pane-harness")).updateModuleMock(),
);
vi.mock("./build-info", async () =>
  (await import("./test-support/agent-pane-harness")).buildInfoModuleMock(),
);
vi.mock("./sounds", async () =>
  (await import("./test-support/agent-pane-harness")).soundsModuleMock(),
);
vi.mock("./toast", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).toastModuleMock(importOriginal),
);
vi.mock("./RadioButton", async () =>
  (await import("./test-support/agent-pane-harness")).radioButtonModuleMock(),
);
vi.mock("./agent", async (importOriginal) =>
  (await import("./test-support/agent-pane-harness")).agentModuleMock(importOriginal),
);

installAgentPaneHooks();

async function renderPane(id: string, opts: { trusted?: boolean } = {}) {
  // Use the real event hook so `shell_*` events reach the pane (reset per test).
  nativeMocks.realMentor = true;
  const pane = client(id, 1);
  vi.mocked(pane.getShellTrust).mockResolvedValue(opts.trusted ?? false);
  const emit = liveEvents(pane);
  vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
  vi.mocked(pane.listShellSuggestions).mockResolvedValue([
    { command: "git status", count: 3 },
    { command: "pnpm test", count: 0, source: "package.json" },
  ]);
  const view = render(<AgentPane client={pane} target={target} />);
  await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
  const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  const enter = () => fireEvent.keyDown(input, { key: "Enter" });
  return { pane, emit, view, input, type, enter };
}

/** The run id the pane sent to the daemon for its last command. */
function lastRunId(pane: ReturnType<typeof client>): string {
  const call = vi.mocked(pane.runShellCommand).mock.calls.at(-1);
  if (!call) throw new Error("no command was started");
  return call[0];
}

describe("AgentPane `!` commands", () => {
  it("typing ! turns the composer into a command box with this pane's picker", async () => {
    const { pane, view, input, type } = await renderPane("shell-box");
    const wrap = view.container.querySelector(".inputwrap");
    expect(wrap?.classList.contains("shell-mode")).toBe(false);

    type("!");
    expect(wrap?.classList.contains("shell-mode")).toBe(true);
    expect(input.classList.contains("input-shell")).toBe(true);
    expect(screen.getByRole("button", { name: "Run command" })).toBeTruthy();
    // A command runs as typed: no Enhance pill.
    expect(view.container.querySelector(".enhance-pill-host.visible")).toBeNull();
    await waitFor(() => expect(pane.listShellSuggestions).toHaveBeenCalled());
    expect(await screen.findByText("git status")).toBeTruthy();
    expect(screen.getByText("from package.json")).toBeTruthy();

    // Enter on a bare `!` fills the highlighted command instead of running it.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("!git status");
    expect(pane.runShellCommand).not.toHaveBeenCalled();

    type("fix this!");
    expect(wrap?.classList.contains("shell-mode")).toBe(false);
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("asks before running, runs only after Run once, and Cancel runs nothing", async () => {
    const { pane, type, enter, input } = await renderPane("shell-confirm");
    type("!echo hello");
    enter();
    const ask = await screen.findByRole("group", { name: "Run this command?" });
    expect(within(ask).getByText("echo hello")).toBeTruthy();
    expect(input.value).toBe("");
    expect(pane.runShellCommand).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();

    fireEvent.click(within(ask).getByRole("button", { name: "Run once" }));
    await waitFor(() =>
      expect(pane.runShellCommand).toHaveBeenCalledWith(expect.any(String), "echo hello", true),
    );

    type("!rm -rf build");
    enter();
    const second = (await screen.findAllByRole("group", { name: "Run this command?" })).at(-1);
    if (!second) throw new Error("no confirmation");
    fireEvent.click(within(second).getByRole("button", { name: "Cancel" }));
    expect(pane.runShellCommand).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/rm -rf build/)).toBeTruthy();
  });

  it("falls back to asking when the daemon requires confirmation for a trusted project", async () => {
    const { pane, type, enter } = await renderPane("shell-required", { trusted: true });
    await waitFor(() => expect(pane.getShellTrust).toHaveBeenCalled());
    vi.mocked(pane.runShellCommand).mockResolvedValueOnce({
      ok: false,
      error: "confirmation_required",
    });
    type("!ls");
    enter();
    // Trusted locally, so the pane tried without asking; the daemon said no.
    await waitFor(() =>
      expect(pane.runShellCommand).toHaveBeenCalledWith(expect.any(String), "ls", false),
    );
    const ask = await screen.findByRole("group", { name: "Run this command?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Run once" }));
    await waitFor(() =>
      expect(pane.runShellCommand).toHaveBeenLastCalledWith(expect.any(String), "ls", true),
    );
  });

  it("streams output into the row and stops through this pane's client", async () => {
    const { pane, emit, type, enter } = await renderPane("shell-stream");
    type("!node build.js");
    enter();
    fireEvent.click(await screen.findByRole("button", { name: "Run once" }));
    await waitFor(() => expect(pane.runShellCommand).toHaveBeenCalled());
    const id = lastRunId(pane);

    act(() => emit("shell_output", { id, chunk: "step 1\n" }));
    act(() => emit("shell_output", { id, chunk: "step 2\n" }));
    const row = screen.getByRole("group", { name: "Command: node build.js" });
    await waitFor(() => expect(row.textContent).toContain("step 1\nstep 2"));
    expect(within(row).getByText(/Running/)).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Stop node build.js" }));
    expect(pane.cancelShellCommand).toHaveBeenCalledWith(id);
    act(() =>
      emit("shell_end", { id, exitCode: null, durationMs: 900, cancelled: true, truncated: false }),
    );
    expect(await within(row).findByText("Stopped")).toBeTruthy();
    expect(within(row).getByText("GG will see this with your next message")).toBeTruthy();
  });

  it("ignores another pane's command events", async () => {
    const { emit, type, enter, pane } = await renderPane("shell-other");
    type("!pwd");
    enter();
    fireEvent.click(await screen.findByRole("button", { name: "Run once" }));
    await waitFor(() => expect(pane.runShellCommand).toHaveBeenCalled());
    act(() => emit("shell_output", { id: "sh-someone-else", chunk: "not mine\n" }));
    expect(screen.queryByText(/not mine/)).toBeNull();
  });

  it(
    "renders the real daemon's redacted output, never the secret",
    { timeout: 120_000 },
    async () => {
      const secret = `sk-fork-shell-${"x".repeat(24)}`;
      await withRealSidecar(
        async ({ project, manager, open, request, subscribe }) => {
          const saved = await manager.create(project, "openai", "gpt-5", {
            openAICodexContextProfile: "stable",
          });
          const logicalId = await open(saved.path);
          nativeMocks.realMentor = true;
          const pane = client(logicalId, 1);
          const emit = liveEvents(pane);
          vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
          vi.mocked(pane.runShellCommand).mockImplementation(async (id, command, confirmed) => {
            const res = await request("/shell/run", logicalId, { id, command, confirmed });
            if (res.ok) return { ok: true };
            const body = (await res.json()) as { error?: string };
            return { ok: false, error: body.error ?? `HTTP ${res.status}` };
          });
          const stream = await subscribe(logicalId, (event) =>
            act(() => emit(event.type, event.data)),
          );
          render(<AgentPane client={pane} target={target} />);
          const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
          await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
          fireEvent.change(input, { target: { value: "!echo key=$QWEN_CLOUD_TOKEN_PLAN_KEY" } });
          fireEvent.keyDown(input, { key: "Enter" });
          fireEvent.click(await screen.findByRole("button", { name: "Run once" }));
          await stream.waitFor("shell_end");
          const row = await screen.findByRole("group", {
            name: "Command: echo key=$QWEN_CLOUD_TOKEN_PLAN_KEY",
          });
          await waitFor(() => expect(row.textContent).toContain("key=[REDACTED]"));
          expect(document.body.textContent).not.toContain(secret);
          expect(within(row).getByText("exit 0")).toBeTruthy();
          const streamed = stream.events
            .filter((e) => e.type === "shell_output")
            .map((e) => String(e.data.chunk))
            .join("");
          expect(streamed).not.toContain(secret);
        },
        { qwenRuntimeKey: secret },
      );
    },
  );
});
