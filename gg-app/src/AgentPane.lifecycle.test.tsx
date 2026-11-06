// @vitest-environment jsdom
import fs from "node:fs/promises";
import path from "node:path";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as AgentModule from "./agent";
import { MENTOR_HANDLE } from "./brand";
import { withRealSidecar } from "../../packages/ggcoder/src/test-support/real-sidecar";
import { AgentPane } from "./AgentPane";
import { noInputSlashSubmissionError } from "./slash-input-policy";
import { PlanMutationError, PromptSubmissionError } from "./agent";
import type { PaneInputActions, PaneSnapshot } from "./AgentPane";
import type { AgentState, PaneAgentClient } from "./agent";
import {
  nativeMocks,
  programmaticView,
  target,
  chatTarget,
  roadmapDraft,
  agentState,
  deferred,
  paneEvents,
  liveEvents,
  client,
  renderKenPromptPane,
  openMoreMenus,
  openStep,
  inStep,
  installAgentPaneHooks,
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

describe("AgentPane lifecycle", () => {
  it("rehydrates a durable accessible MCP failure transcript row", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(pane.listHistory).mockResolvedValue([
      {
        role: "assistant",
        text: "",
        mcpToolFailure: {
          name: "mcp__acceptance__fixture_is_error",
          result: "fixture-is-error",
        },
      },
    ]);

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);

    const failedRow = await screen.findByRole("status", {
      name: "Failed MCP tool: acceptance / fixture_is_error",
    });
    expect(failedRow.textContent).toContain("Failed");
    expect(failedRow.textContent).toContain("fixture-is-error");
  });

  it.each([false, undefined])(
    "locks context without authority (%s), retaining value",
    async (canChange) => {
      const pane = client("astra-locked", 1);
      const reason =
        "Context mode is fixed after this session starts. Start a new session to change it.";
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("gpt-6-astra"),
        provider: "openai",
        accountId: "account-1",
        openAICodexContextProfile: "experimental",
        openAICodexContextProfileEligibility:
          canChange === false ? { canChange: false, reason } : undefined,
      } as unknown as AgentState);
      render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
      await openMoreMenus();
      const selector = (await screen.findByRole("combobox", {
        name: "OpenAI Codex context profile",
      })) as HTMLSelectElement;
      expect(selector.disabled).toBe(true);
      expect(selector.value).toBe("experimental");
      expect(selector.title).toBe(reason);
      expect(document.getElementById(selector.getAttribute("aria-describedby")!)?.textContent).toBe(
        reason,
      );
      fireEvent.change(selector, { target: { value: "stable" } });
      expect(pane.setOpenAICodexContextProfile).not.toHaveBeenCalled();
    },
  );

  it("shows context profiles only for GPT-6 Astra using Codex OAuth", async () => {
    const oauthPane = client("astra-oauth", 1);
    vi.mocked(oauthPane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextTokens: 136_000,
      contextWindow: 272_000,
    });
    const mounted = render(
      <AgentPane client={oauthPane} target={target} workspaceOwnsSessionLifecycle />,
    );
    await openMoreMenus();
    expect(
      await screen.findByRole("combobox", { name: "OpenAI Codex context profile" }),
    ).toBeDefined();
    expect(screen.getByText("136,000 / 272K · 50%")).toBeDefined();
    // Fork: the retired Fast switch must not come back next to the picker.
    expect(screen.queryByRole("switch", { name: /Fast/ })).toBeNull();
    mounted.unmount();

    // Fork: Astra Fast is the same model at priority, so its context
    // profiles stay reachable after the toggle's retirement.
    const fastPane = client("astra-fast-oauth", 1);
    vi.mocked(fastPane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra-fast"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    const fastMounted = render(
      <AgentPane client={fastPane} target={target} workspaceOwnsSessionLifecycle />,
    );
    await openMoreMenus();
    const fastSelector = (await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    })) as HTMLSelectElement;
    expect(fastSelector.value).toBe("experimental");
    fastMounted.unmount();

    const apiKeyPane = client("astra-api-key", 1);
    vi.mocked(apiKeyPane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      openAICodexContextProfile: "stable",
      contextWindow: 1_050_000,
    });
    render(<AgentPane client={apiKeyPane} target={target} workspaceOwnsSessionLifecycle />);
    await screen.findAllByText("gpt-6-astra");
    await openMoreMenus();
    expect(screen.queryByRole("combobox", { name: "OpenAI Codex context profile" })).toBeNull();
  });

  it("keeps Astra controls independent across panes", async () => {
    const left = client("astra-left", 1);
    const right = client("astra-right", 1);
    vi.mocked(left.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "left-account",
      openAICodexContextProfile: "stable",
      contextTokens: 136_000,
      contextWindow: 272_000,
    });
    vi.mocked(right.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "right-account",
      openAICodexContextProfile: "experimental",
      contextTokens: 300_000,
      contextWindow: 872_000,
    });

    render(
      <>
        <AgentPane client={left} target={target} workspaceOwnsSessionLifecycle />
        <AgentPane client={right} target={target} workspaceOwnsSessionLifecycle />
      </>,
    );
    await openMoreMenus(2);
    const selectors = await screen.findAllByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    expect(selectors.map((selector) => (selector as HTMLSelectElement).value)).toEqual([
      "stable",
      "experimental",
    ]);
    expect(screen.getByText("136,000 / 272K · 50%")).toBeDefined();
    expect(screen.getByText("300,000 / 872K · 34%")).toBeDefined();
  });

  it.each([
    "cannot switch Ken's model while running",
    "unknown model: missing",
    "invalid Ken model response",
  ])("preserves all Ken fields and displays rejected selection: %s", async (message) => {
    const pane = client("ken-selection", 1);
    const prior = { kenProvider: "anthropic", kenModel: "claude-prior", kenModelOverride: true };
    vi.mocked(pane.getState).mockResolvedValue({ ...agentState("gpt"), ...prior });
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "claude-prior", provider: "anthropic", name: "Prior" },
      { id: "missing", provider: "openai", name: "Missing" },
    ]);
    vi.mocked(pane.switchKenModel).mockRejectedValue(message);
    await act(async () => {
      render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    });
    // 0.91 Deck: Ken's picker is the second target key inside the model panel.
    fireEvent.click(await screen.findByRole("button", { name: /^Model .*\. Change$/ }));
    const picker = await screen.findByTitle(/is pinned to a separate model/);
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: /Missing/ }));
    await waitFor(() => expect(nativeMocks.toast).toHaveBeenCalledWith(message, "error"));
    expect(pane.switchKenModel).toHaveBeenCalledExactlyOnceWith("missing");
    expect(nativeMocks.kenStateRef?.current).toMatchObject(prior);
    expect(picker.textContent).toContain("Prior");
    expect(picker.title).toContain("pinned");
  });

  it("tells GG's and Ken's model pickers apart by role, not only by tooltip", async () => {
    const pane = client("model-roles", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("claude-prior"),
      kenModel: "claude-prior",
      kenModelOverride: true,
    });
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "claude-prior", provider: "anthropic", name: "Prior" },
    ]);
    await act(async () => {
      render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Model .*\. Change$/ }));
    const ken = await screen.findByTitle(/is pinned to a separate model/);
    const gg = screen.getByTitle("Switch Supah Coder's model");
    const describedText = (el: HTMLElement): string =>
      document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    expect(describedText(gg)).toBe("Supah Coder's model — does the work");
    expect(describedText(ken)).toBe("Ken's model — reviews Supah Coder's work and answers @Ken");
    // The visible labels carry the same role as a tooltip.
    expect(screen.getByTitle("Supah Coder's model — does the work").textContent).toContain("GG");
    expect(
      screen.getByTitle("Ken's model — reviews Supah Coder's work and answers @Ken").textContent,
    ).toContain("Ken");
  });

  it("disables the context profile selector while running", async () => {
    const pane = client("astra-running", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
      running: true,
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await openMoreMenus();
    expect(
      (await screen.findByRole("combobox", {
        name: "OpenAI Codex context profile",
      })) as HTMLSelectElement,
    ).toMatchObject({ disabled: true });
  });

  it("disables Astra controls while Autopilot owns the session", async () => {
    const pane = client("astra-autopilot", 1);
    const emit = paneEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await openMoreMenus();
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });

    act(() => emit?.({ type: "autopilot_review_start", data: {} }));
    await waitFor(() => expect(selector).toMatchObject({ disabled: true }));

    act(() => emit?.({ type: "autopilot_done", data: {} }));
    await waitFor(() => expect(selector).toMatchObject({ disabled: false }));
  });

  it.each([false, true])("restores context profile focus unless moved (%s)", async (moved) => {
    const pane = client("astra-switch", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "stable",
      contextWindow: 272_000,
    });
    const mutation = deferred<{
      openAICodexContextProfile: "experimental";
      contextWindow: number;
    }>();
    vi.mocked(pane.setOpenAICodexContextProfile).mockReturnValue(mutation.promise);
    render(
      <>
        <button>Other control</button>
        <AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />
      </>,
    );
    await openMoreMenus();
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    selector.focus();
    fireEvent.change(selector, { target: { value: "experimental" } });
    // WebView2 drops focus when a focused select is disabled; jsdom does not.
    const other = screen.getByRole("button", { name: "Other control" });
    other.focus();
    if (!moved) other.blur();
    expect(document.activeElement).toBe(moved ? other : document.body);
    expect((selector as HTMLSelectElement).value).toBe("experimental");
    expect(selector).toMatchObject({ disabled: true });
    await waitFor(() =>
      expect(pane.setOpenAICodexContextProfile).toHaveBeenCalledWith("experimental"),
    );
    mutation.resolve({ openAICodexContextProfile: "experimental", contextWindow: 872_000 });
    await waitFor(() => expect(selector).toMatchObject({ disabled: false }));
    expect(document.activeElement).toBe(moved ? other : selector);
  });

  it("preserves newer authoritative state when a profile mutation fails", async () => {
    const pane = client("astra-stale", 1);
    const emit = paneEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    const mutation = deferred<{
      openAICodexContextProfile: "stable" | "experimental";
      contextWindow: number;
    }>();
    vi.mocked(pane.setOpenAICodexContextProfile).mockReturnValue(mutation.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    // 0.91 Deck: the Astra controls live in the More menu.
    await openMoreMenus();
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    fireEvent.change(selector, { target: { value: "stable" } });
    await waitFor(() => expect(emit).toBeDefined());
    act(() =>
      emit?.({
        type: "context_profile_change",
        data: { openAICodexContextProfile: "stable", contextWindow: 272_000 },
      }),
    );
    mutation.reject(new Error("stale refusal"));

    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe("stable"));
  });

  it("displays a refused context-profile change without mutating the selector", async () => {
    const pane = client("astra-refusal", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-6-astra"),
      provider: "openai",
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    vi.mocked(pane.setOpenAICodexContextProfile).mockRejectedValue(
      new Error("Compact or start a new session first."),
    );
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    // 0.91 Deck: the Astra controls live in the More menu.
    await openMoreMenus();
    const selector = await screen.findByRole("combobox", {
      name: "OpenAI Codex context profile",
    });
    fireEvent.change(selector, { target: { value: "stable" } });
    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        "Compact or start a new session first.",
        "error",
      ),
    );
    expect((selector as HTMLSelectElement).value).toBe("experimental");
  });

  it("wires the restored home UI through the pane-scoped catalog client", async () => {
    const pane = client("primary", 1);
    render(<AgentPane client={pane} />);

    await waitFor(() =>
      expect(document.querySelector('[data-testid="home-screen"]')).not.toBeNull(),
    );
    const home = document.querySelector('[data-testid="home-screen"]');
    expect(home?.getAttribute("data-has-pane-ready")).toBe("true");
    // Upstream 0.91 tidied Home: the rank badge moved into the Deck, so Home
    // no longer loads progress at all.
    expect(home?.getAttribute("data-has-pane-progress")).toBe("false");
    expect(pane.create).not.toHaveBeenCalled();
  });

  it("manages MCP from an unstarted home pane through the running catalog client", async () => {
    const pane = client("pane-3", 1);
    render(
      <AgentPane
        client={pane}
        paneId="pane-3"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );

    await screen.findByTestId("home-screen");
    fireEvent.click(screen.getByRole("button", { name: "Open MCP settings" }));
    const settings = await screen.findByTestId("settings-screen");
    expect(settings.getAttribute("data-tab")).toBe("mcp");
    expect(settings.getAttribute("data-mcp-pane")).toBe("primary");
    expect(pane.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("home-screen")).toBeTruthy();
  });

  it("renders the local-build identity in the agent footer", async () => {
    const pane = client("pane-1", 1);
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    // 0.91 Deck: the build identity lives in the title bar's More menu.
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect((await screen.findByText("◆ Supah Coder Local Fork · abc1234")).className).toBe(
      "key footer-custom-build",
    );
    // The 0.91 shell has no footer dividers; any decorative divider that
    // remains must still stay silent for screen readers.
    for (const sep of document.querySelectorAll(".footer-sep")) {
      expect(sep.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("presents the compatible general chat agent as Brainstorm", async () => {
    const pane = client("pane-brainstorm", 1);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      mode: "chat",
      chatAgent: "general",
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    expect(await screen.findByText("Brainstorm")).toBeDefined();
    expect(screen.queryByText("General Agent")).toBeNull();
  });

  it("adopts a switched pane generation before the next selection", async () => {
    const pane = client("pane-1", 3);
    vi.mocked(pane.selectWorkspace).mockResolvedValueOnce(4).mockResolvedValueOnce(5);
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 4,
      sessionId: "pane-1",
    });
    const onUserTargetChange = vi.fn();
    const onGenerationChange = vi.fn();
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
        onUserTargetChange={onUserTargetChange}
        onGenerationChange={onGenerationChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    await waitFor(() => expect(onGenerationChange).toHaveBeenCalledWith(4));
    fireEvent.click(await screen.findByRole("button", { name: /Back to this project's sessions/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));

    await waitFor(() =>
      expect(pane.selectWorkspace).toHaveBeenLastCalledWith(
        { mode: "code", cwd: "/chosen", sessionPath: "/chosen.jsonl" },
        4,
      ),
    );
    expect(onGenerationChange).toHaveBeenCalledWith(5);
    expect(onUserTargetChange).toHaveBeenCalledTimes(2);
  });

  it("reloads and replaces the pane model catalog after a native refresh", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "azure:gpt-old", name: "Azure old", provider: "azure" },
    ]);
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        kind="auxiliary"
        initialTarget={null}
        workspaceOwnsSessionLifecycle
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    vi.mocked(pane.listModels).mockClear().mockResolvedValue([]);
    vi.mocked(pane.waitForReady).mockClear();

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(pane.listModels).toHaveBeenCalledOnce());
    expect(pane.waitForReady).toHaveBeenCalledOnce();
  });

  it("closes an open model menu even when the refreshed catalog compares equal", async () => {
    const pane = client("pane-1", 1);
    const catalog = [{ id: "azure:gpt-old", name: "Azure old", provider: "azure" }];
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-old"));
    vi.mocked(pane.listModels).mockResolvedValue(catalog);
    const view = render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    // 0.91 Deck: the model key opens the model panel's listbox.
    const modelButton = await screen.findByRole("button", { name: /^Model .*\. Change$/ });
    await waitFor(() => expect((modelButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(modelButton);
    expect(await screen.findByRole("listbox", { name: "GG's model" })).toBeTruthy();

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("listbox", { name: "GG's model" })).toBeNull());
    view.unmount();
    await waitFor(() => expect(nativeMocks.modelsUnlisten).toHaveBeenCalledOnce());
  });

  it("adopts the recovered generation after daemon respawn", async () => {
    const pane = client("pane-1", 1);
    const onGenerationChange = vi.fn();
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-old"));
    vi.mocked(pane.listModels).mockResolvedValue([
      { id: "azure:gpt-old", name: "Azure old", provider: "azure" },
    ]);
    render(<AgentPane client={pane} onGenerationChange={onGenerationChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    // 0.91 Deck: the title bar's model key names the current model.
    const modelButton = await screen.findByRole("button", { name: /^Model .*\. Change$/ });
    await waitFor(() => expect(modelButton.textContent).toContain("Azure old"));
    onGenerationChange.mockClear();
    vi.mocked(pane.waitForReady).mockResolvedValue({
      ready: true,
      error: null,
      generation: 2,
      sessionId: "pane-1",
    });
    vi.mocked(pane.getState).mockReset().mockResolvedValue(agentState("azure:gpt-new"));
    vi.mocked(pane.listModels)
      .mockReset()
      .mockResolvedValue([{ id: "azure:gpt-new", name: "Azure new", provider: "azure" }]);

    await act(async () => {
      nativeMocks.modelsChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(onGenerationChange).toHaveBeenCalledWith(2));
    expect(screen.getByRole("button", { name: /^Model .*\. Change$/ }).textContent).toContain(
      "Azure new",
    );
  });

  it("separate pane clients create and subscribe independently", async () => {
    const left = client("left", 1),
      right = client("right", 2);
    const view = render(
      <>
        <AgentPane client={left} target={target} />
        <AgentPane client={right} target={target} />
      </>,
    );
    await waitFor(() => expect(left.create).toHaveBeenCalledWith(target));
    expect(right.create).toHaveBeenCalledWith(target);
    expect(left.subscribe).toHaveBeenCalled();
    expect(right.subscribe).toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(left.dispose).toHaveBeenCalledWith(1));
    expect(right.dispose).toHaveBeenCalledWith(2);
  });

  it("reports autopilot review as active work until a terminal autopilot event", async () => {
    const pane = client("pane-1", 7);
    const onSnapshot = vi.fn<(snapshot: PaneSnapshot) => void>();
    render(
      <AgentPane
        client={pane}
        paneId="pane-1"
        target={target}
        workspaceOwnsSessionLifecycle
        onSnapshot={onSnapshot}
      />,
    );
    await waitFor(() => {
      expect(pane.subscribe).toHaveBeenCalled();
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: false }),
      );
    });
    const handleEvent = paneEvents(pane);
    expect(handleEvent).toBeDefined();

    act(() => handleEvent?.({ type: "autopilot_review_start", data: {} }));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: true }),
      ),
    );

    act(() => handleEvent?.({ type: "autopilot_done", data: {} }));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ paneId: "pane-1", activeWork: false }),
      ),
    );
  });

  it("hydrates a pending Roadmap draft in chat and keeps it reopenable after close", async () => {
    const pane = client("pane-chat-hydration", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce();
    const trigger = screen.getByRole("button", {
      name: "Review Roadmap draft with 1 proposed phase",
    });

    fireEvent.click(screen.getByRole("button", { name: /Roadmap draft.*Collapse/ }));
    expect(screen.queryByRole("region", { name: "Review Roadmap draft" })).toBeNull();
    expect(trigger).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(pane.approveRoadmapPhaseDraft).not.toHaveBeenCalled();
    expect(pane.rejectRoadmapPhaseDraft).not.toHaveBeenCalled();
  });

  it("opens and exposes Roadmap drafts received live in chat", async () => {
    const pane = client("pane-chat-live-draft", 7);
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce());
    const handleEvent = paneEvents(pane);

    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: roadmapDraft,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("labels and applies a pending Roadmap phase edit from the review dock", async () => {
    const pane = client("pane-chat-phase-edit", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue({
      kind: "edit",
      id: "draft-edit",
      projectKey: "/work",
      basedOnRevision: 12,
      createdAt: "2026-08-05T12:00:00.000Z",
      createdBySessionId: "session-1",
      summary: "Clarify the approval phase",
      phaseId: "phase-approval",
      phaseTitle: "Approval UI",
      basedOnUpdatedAt: "2026-08-04T12:00:00.000Z",
      changes: [{ field: "goal", before: "", after: "Require an explicit decision." }],
      status: "pending",
    });
    vi.mocked(pane.approveRoadmapPhaseDraft).mockResolvedValue({
      status: "edited",
      revision: 13,
      phaseId: "phase-approval",
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    const trigger = await screen.findByRole("button", {
      name: "Review Roadmap phase edit with 1 changed field",
    });
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Review Roadmap phase edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Roadmap phase edit.*Collapse/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(pane.approveRoadmapPhaseDraft).toHaveBeenCalledWith("draft-edit"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Review Roadmap phase edit with 1 changed field" }),
      ).toBeNull(),
    );
    expect(pane.rejectRoadmapPhaseDraft).not.toHaveBeenCalled();
    expect(pane.startPhase).not.toHaveBeenCalled();
  });

  it("discovers /research and carries its submission into pending draft review", async () => {
    const pane = client("pane-chat-research-command", 7);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "research",
        aliases: [],
        description: "Research this conversation and draft net-new Roadmap phases",
        input: { text: "optional", references: "optional", attachments: "optional" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const input = await screen.findByRole("textbox");

    fireEvent.change(input, { target: { value: "/res" } });
    expect(await screen.findByText("/research")).toBeTruthy();
    expect(
      screen.getByText("Research this conversation and draft net-new Roadmap phases"),
    ).toBeTruthy();

    const command = "/research approval UX";
    fireEvent.change(input, { target: { value: command } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(command, [], undefined));

    const handleEvent = paneEvents(pane);
    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: roadmapDraft,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("surfaces prompt submission failures in the transcript", async () => {
    const pane = client("pane-prompt-failure", 7);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("plan approval handoff failed"));
    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    const input = await screen.findByRole("textbox");

    fireEvent.change(input, { target: { value: "continue after the plan" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("plan approval handoff failed")).toBeTruthy();
  });

  it("approves a chat Roadmap draft without starting implementation or a coding session", async () => {
    const pane = client("pane-chat-approve", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.approveRoadmapPhaseDraft).mockResolvedValue({
      status: "created",
      revision: 13,
      phaseIds: ["phase-research"],
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create phases with references" }));

    await waitFor(() =>
      expect(pane.approveRoadmapPhaseDraft).toHaveBeenCalledWith("draft-research"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeNull();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.acceptPlan).not.toHaveBeenCalled();
  });

  it("rejects and discards a chat Roadmap draft without starting other workflows", async () => {
    const pane = client("pane-chat-reject", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.rejectRoadmapPhaseDraft).mockResolvedValue({ status: "rejected" });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject draft" }));

    await waitFor(() =>
      expect(pane.rejectRoadmapPhaseDraft).toHaveBeenCalledWith("draft-research"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeNull();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.newSession).not.toHaveBeenCalled();
    expect(pane.acceptPlan).not.toHaveBeenCalled();
  });

  it("shows stale chat drafts without allowing approval", async () => {
    const pane = client("pane-chat-stale", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue({
      ...roadmapDraft,
      status: "stale",
    });

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("This draft is out of date.");
    expect(
      (
        screen.getByRole("button", {
          name: "Create phases with references",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
  });

  it("keeps a chat draft reviewable when approval fails", async () => {
    const pane = client("pane-chat-approval-error", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);
    vi.mocked(pane.approveRoadmapPhaseDraft).mockRejectedValue(
      new Error("approval transport failed"),
    );

    render(<AgentPane client={pane} target={chatTarget} workspaceOwnsSessionLifecycle />);
    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create phases with references" }));

    expect((await screen.findByRole("alert")).textContent).toContain("approval transport failed");
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
    expect(pane.startPhase).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("preserves coding-mode Roadmap draft hydration and review", async () => {
    const pane = client("pane-code-draft", 7);
    vi.mocked(pane.getRoadmapPhaseDraft).mockResolvedValue(roadmapDraft);

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(pane.getRoadmapPhaseDraft).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Review Roadmap draft with 1 proposed phase" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("shows an approval draft after an unqualified natural-language Roadmap request", async () => {
    const pane = client("pane-roadmap-intent", 7);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() => expect(pane.selectWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    const input = await screen.findByRole("textbox");

    const request = "Add release hardening to our roadmap.";
    fireEvent.change(input, { target: { value: request } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(request, [], undefined));

    const handleEvent = paneEvents(pane);
    act(() =>
      handleEvent?.({
        type: "roadmap_phase_draft_change",
        data: {
          id: "draft-intent-proof",
          projectKey: "/work",
          basedOnRevision: 8,
          createdAt: "2026-08-05T12:00:00.000Z",
          createdBySessionId: "pane-roadmap-intent",
          summary: "Add release hardening without duplicating existing delivery work.",
          phases: [
            {
              phaseId: "phase-release-hardening",
              title: "Release hardening",
              goal: "Prove the release is safe to ship and recover.",
              doneWhen: ["Critical release checks pass", "Rollback is rehearsed"],
              sourcePrompt: request,
            },
          ],
          status: "pending",
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /Review Roadmap draft with/ }));
    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Review Roadmap draft" })).toBeNull();
    expect(screen.getByText("Proposed from Project Notes revision 8")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Release hardening" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create phase" })).toBeTruthy();
  });

  it.each([
    ["selection", "C:\\picked"],
    ["cancellation", null],
  ] as const)("restores composer focus after add-dir picker %s", async (_outcome, selected) => {
    const pane = client("pane-add-dir-focus", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "add-dir",
        aliases: [],
        description: "Add project folder",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    const picker = deferred<string | null>();
    nativeMocks.openDialog.mockReturnValueOnce(picker.promise);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    input.focus();

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText("/add-dir"));
    await waitFor(() => expect(nativeMocks.openDialog).toHaveBeenCalledOnce());
    expect(document.activeElement).not.toBe(input);

    await act(async () => picker.resolve(selected));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(pane.sendPrompt).toHaveBeenCalledTimes(selected === null ? 0 : 1);
  });

  it.each(
    (["normal", "queued", "toolbar"] as const).flatMap((source) =>
      [false, true].flatMap((rejected) =>
        [false, true].map((stale) => ({ source, rejected, stale })),
      ),
    ),
  )(
    "presents prompt certainty honestly ($source, rejected=$rejected, stale=$stale)",
    async ({ source, rejected, stale }) => {
      const pane = client("prompt-certainty", 1);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running: source === "queued",
        // The 0.91 title bar shows the commit key only with dirty files.
        gitDirtyFileCount: 1,
      });
      vi.mocked(pane.listCommands).mockResolvedValue([
        {
          name: "commit",
          aliases: [],
          description: "Commit changes",
          source: "built-in",
          input: { text: "optional", references: "optional", attachments: "optional" },
        },
      ]);
      const receipt = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt).mockReturnValueOnce(receipt.promise);
      const view = render(
        <AgentPane client={pane} target={target} generation={1} workspaceOwnsSessionLifecycle />,
      );
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: "/programmatic check tests" } });
      if (source === "toolbar") fireEvent.click(await screen.findByTitle("Run /commit"));
      else fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
      if (stale) {
        view.rerender(
          <AgentPane client={pane} target={target} generation={2} workspaceOwnsSessionLifecycle />,
        );
        await act(async () => {});
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "New session draft" } });
      }
      const message = "Remove attachments and send the command again.";
      await act(async () =>
        receipt.reject(
          new PromptSubmissionError(
            rejected
              ? { category: "rejected", code: "command_input_not_allowed", message }
              : new Error("Connection closed before acknowledgement"),
          ),
        ),
      );
      expect(pane.sendPrompt).toHaveBeenCalledOnce();
      if (stale) {
        expect(screen.queryByText("Prompt wasn’t sent")).toBeNull();
        expect(screen.queryByText("Prompt status is uncertain")).toBeNull();
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
          "New session draft",
        );
        return;
      }
      expect((input as HTMLTextAreaElement).value).toBe("/programmatic check tests");
      if (rejected) {
        expect(await screen.findByText("Prompt wasn’t sent")).toBeTruthy();
        expect(screen.getByText(message)).toBeTruthy();
        expect(screen.getByText("Review the error above before sending again.")).toBeTruthy();
        expect(view.container.querySelector(".user-msg")).toBeNull();
      } else {
        expect(await screen.findByText("Prompt status is uncertain")).toBeTruthy();
        expect(
          screen.getByText(
            "The prompt may have been accepted. Check this session’s activity and history before deciding whether to send it again.",
          ),
        ).toBeTruthy();
        expect(screen.queryByText("Prompt wasn’t sent")).toBeNull();
        expect(screen.queryByText("Retry your prompt.")).toBeNull();
        expect(view.container.querySelectorAll(".user-msg")).toHaveLength(
          source === "normal" ? 1 : 0,
        );
      }
    },
  );

  it("reports a busy-session mutation conflict as not sent rather than uncertain", async () => {
    const pane = client("pane-mutation-conflict", 8);
    vi.mocked(pane.getState).mockResolvedValue({ ...agentState("azure:gpt-test"), running: true });
    const submission = deferred<AgentModule.PromptSubmissionResult>();
    vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
    const view = render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Second quick message" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    const message =
      "Another change to this session was still finishing, so this message wasn't sent. Send it again.";
    await act(async () =>
      submission.reject(
        new PromptSubmissionError({
          category: "rejected",
          code: "session_mutation_in_progress",
          message,
        }),
      ),
    );
    expect(await screen.findByText("Prompt wasn’t sent")).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText("Prompt status is uncertain")).toBeNull();
    expect(view.container.querySelector(".user-msg")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("Second quick message");
  });

  it.each([false, true])(
    "retains rejected composer submissions while running=%s",
    async (running) => {
      const pane = client("pane-send-recovery", 8);
      vi.mocked(pane.getState).mockResolvedValue({ ...agentState("azure:gpt-test"), running });
      vi.mocked(pane.searchFiles).mockResolvedValue([
        { path: "src/context.ts", name: "context.ts" },
      ]);
      const submission = deferred<AgentModule.PromptSubmissionResult>();
      vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
      const actionsRef: { current: PaneInputActions | null } = { current: null };
      render(
        <AgentPane
          client={pane}
          target={target}
          registerInput={(_id, actions) => {
            actionsRef.current = actions;
          }}
        />,
      );
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      await act(async () => actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]));
      await screen.findByRole("button", { name: "Remove file.txt" });
      fireEvent.change(input, { target: { value: "@context" } });
      fireEvent.click(await screen.findByText("context.ts"));
      await screen.findByRole("button", { name: "Remove src/context.ts" });
      fireEvent.change(input, { target: { value: "Keep this prompt" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
      await act(async () =>
        submission.reject(
          new PromptSubmissionError({
            category: "rejected",
            code: "command_input_not_allowed",
            message: "Remove attachments and send the command again.",
          }),
        ),
      );
      expect(await screen.findByText("Prompt wasn’t sent")).toBeTruthy();
      expect((input as HTMLTextAreaElement).value).toBe("Keep this prompt");
      expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove src/context.ts" })).toBeTruthy();
      vi.mocked(pane.sendPrompt).mockResolvedValueOnce(
        running
          ? { queued: true, count: 1, queueId: "q1", steers: false }
          : { queued: false, count: 0 },
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(2));
      expect(vi.mocked(pane.sendPrompt).mock.calls[1]).toEqual(
        vi.mocked(pane.sendPrompt).mock.calls[0],
      );
      await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
      // Cleared chips play a short exit animation before they unmount.
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Remove file.txt" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Remove src/context.ts" })).toBeNull();
      });
    },
  );

  it.each(
    [false, true].flatMap((busy) => ["", "Keep this file draft"].map((text) => ({ busy, text }))),
  )(
    "retains attachments after upload rejection (busy=$busy, text='$text')",
    async ({ busy, text }) => {
      await withRealSidecar(async ({ project, manager, open, request, generation }) => {
        const saved = await manager.create(project, "openai", "gpt-5", {
          openAICodexContextProfile: "stable",
        });
        const logicalId = await open(saved.path);
        if (busy) {
          expect((await request("/prompt", logicalId, { text: "Hold generation" })).status).toBe(
            202,
          );
          await generation.started;
        }
        await fs.mkdir(path.join(project, ".gg"), { recursive: true });
        await fs.writeFile(path.join(project, ".gg", "uploads"), "blocked");
        const pane = client(logicalId, 8);
        vi.mocked(pane.getState).mockResolvedValue({ ...agentState("gpt-5"), running: busy });
        vi.mocked(pane.sendPrompt).mockImplementation(async (submitted, attachments) => {
          const response = await request("/prompt", logicalId, { text: submitted, attachments });
          expect(response.status).toBe(500);
          const body = await response.json();
          if (!response.ok) throw new Error(body.message);
          throw new Error("Unexpected acceptance");
        });
        const actionsRef: { current: PaneInputActions | null } = { current: null };
        try {
          const view = render(
            <AgentPane
              client={pane}
              target={target}
              registerInput={(_id, actions) => {
                actionsRef.current = actions;
              }}
            />,
          );
          const input = await screen.findByRole("textbox");
          await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
          await act(async () => actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]));
          await screen.findByRole("button", { name: "Remove file.txt" });
          fireEvent.change(input, { target: { value: text } });
          fireEvent.keyDown(input, { key: "Enter" });
          await screen.findByText("Prompt status is uncertain", {}, { timeout: 20_000 });
          expect(await screen.findByText(/Could not save attachment/)).toBeTruthy();
          expect((input as HTMLTextAreaElement).value).toBe(text);
          expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
          // A generic 500 is not an authoritative rejection receipt at the native boundary.
          expect(view.container.querySelectorAll(".user-msg")).toHaveLength(busy ? 0 : 1);
          expect(pane.sendPrompt).toHaveBeenCalledOnce();
        } finally {
          cleanup();
        }
      });
    },
    60_000,
  );

  it("retains composer text, references and attachments after a real required-append rejection", async () => {
    vi.useRealTimers();
    const { requirePromptSubmissionResult } = await vi.importActual<typeof AgentModule>("./agent");
    await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
      const saved = await manager.create(project, "openai", "gpt-5", {
        openAICodexContextProfile: "stable",
      });
      const logicalId = await open(saved.path);
      const pane = client(logicalId, 8);
      vi.mocked(pane.searchFiles).mockResolvedValue([
        { path: "src/context.ts", name: "context.ts" },
      ]);
      let responseStatus: number | undefined;
      // Mock only the native transport: the response comes from the real /prompt route.
      vi.mocked(pane.sendPrompt).mockImplementation(async (text, attachments, meta) => {
        const response = await request("/prompt", logicalId, { text, attachments, meta });
        responseStatus = response.status;
        if (!response.ok) throw new Error(`Prompt rejected: ${response.status}`);
        return requirePromptSubmissionResult(await response.json());
      });
      const emit = liveEvents(pane);
      await subscribe(logicalId, (event) => act(() => emit(event.type, event.data)));
      const actionsRef: { current: PaneInputActions | null } = { current: null };
      try {
        render(
          <AgentPane
            client={pane}
            target={target}
            registerInput={(_id, actions) => {
              actionsRef.current = actions;
            }}
          />,
        );
        const input = await screen.findByRole("textbox");
        await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
        await act(async () => actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]));
        await screen.findByRole("button", { name: "Remove file.txt" });
        fireEvent.change(input, { target: { value: "@context" } });
        fireEvent.click(await screen.findByText("context.ts"));
        await screen.findByRole("button", { name: "Remove src/context.ts" });
        fireEvent.change(input, { target: { value: "Keep this durable draft" } });
        await fs.rename(saved.path, `${saved.path}.backup`);
        await fs.mkdir(saved.path);
        fireEvent.keyDown(input, { key: "Enter" });
        expect(
          await screen.findByText("Prompt status is uncertain", {}, { timeout: 20_000 }),
        ).toBeTruthy();
        expect(responseStatus).toBe(500);
        expect(pane.sendPrompt).toHaveBeenCalledOnce();
        expect((input as HTMLTextAreaElement).value).toBe("Keep this durable draft");
        expect(screen.getByRole("button", { name: "Remove file.txt" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove src/context.ts" })).toBeTruthy();
      } finally {
        cleanup();
      }
    });
  }, 60_000);

  it.each([false, true])("preserves newer typing after send acceptance=%s", async (accepted) => {
    const pane = client("pane-send-newer-draft", 8);
    const submission = deferred<AgentModule.PromptSubmissionResult>();
    vi.mocked(pane.sendPrompt).mockReturnValueOnce(submission.promise);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Original prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: "Newer draft" } });
    await act(async () => {
      if (accepted) submission.resolve({ queued: false, count: 0 });
      else submission.reject(new Error("send rejected"));
    });
    expect((input as HTMLTextAreaElement).value).toBe("Newer draft");
  });

  it.each(["add-dir", "remove-dir"])(`reports failed /%s picker submissions`, async (name) => {
    const pane = client(`pane-${name}-failure`, 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name,
        aliases: [],
        description: "Change workspace folders",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    vi.mocked(pane.sendPrompt).mockRejectedValueOnce(new Error("agent_prompt failed"));
    nativeMocks.openDialog.mockResolvedValueOnce("C:\\picked");
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    input.focus();

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText(`/${name}`));

    expect(await screen.findByText("Prompt status is uncertain")).toBeTruthy();
    expect(await screen.findByText("agent_prompt failed")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it.each(["add-dir", "remove-dir"])(`rejects staged inputs for typed /%s`, (name) => {
    expect(
      noInputSlashSubmissionError(
        `/${name} C:\\typed`,
        [
          {
            name,
            aliases: [],
            description: "Change workspace folders",
            input: { text: "optional", references: "none", attachments: "none" },
            source: "built-in",
          },
        ],
        1,
        1,
      ),
    ).toBe(
      `/${name} does not accept file references, attachments. Remove them and send the command again.`,
    );
  });

  it.each(["add-dir", "remove-dir"])(
    `clears staged inputs before opening the /%s picker`,
    async (name) => {
      const pane = client(`pane-${name}-inputs`, 8);
      vi.mocked(pane.listCommands).mockResolvedValue([
        {
          name,
          aliases: [],
          description: "Change workspace folders",
          input: { text: "optional", references: "none", attachments: "none" },
          source: "built-in",
        },
      ]);
      vi.mocked(pane.searchFiles).mockResolvedValue([
        { path: "src/context.ts", name: "context.ts" },
      ]);
      const picker = deferred<string | null>();
      nativeMocks.openDialog.mockReturnValueOnce(picker.promise);
      const actionsRef: { current: PaneInputActions | null } = { current: null };
      render(
        <AgentPane
          client={pane}
          target={target}
          registerInput={(_paneId, actions) => {
            actionsRef.current = actions;
          }}
        />,
      );
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

      fireEvent.change(input, { target: { value: "@context" } });
      await waitFor(() => expect(pane.searchFiles).toHaveBeenCalledWith("context"));
      fireEvent.click(await screen.findByText("context.ts"));
      expect(await screen.findByRole("button", { name: "Remove src/context.ts" })).toBeTruthy();
      await act(async () => {
        actionsRef.current?.handleNativeDrop(["/dropped/file.txt"]);
        await Promise.resolve();
      });
      expect(await screen.findByRole("button", { name: "Remove file.txt" })).toBeTruthy();
      act(() => actionsRef.current?.setNativeFileDragOver(true));
      expect(document.querySelector(".inputwrap.dragover")).not.toBeNull();

      fireEvent.change(input, { target: { value: "/" } });
      fireEvent.click(await screen.findByText(`/${name}`));
      await waitFor(() => expect(nativeMocks.openDialog).toHaveBeenCalledOnce());

      // The picker is still open (unresolved); cleared chips only need their
      // short exit animation to finish before they unmount.
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Remove src/context.ts" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Remove file.txt" })).toBeNull();
      });
      expect(document.querySelector(".inputwrap.dragover")).toBeNull();
      expect((input as HTMLTextAreaElement).value).toBe("");
      expect(pane.sendPrompt).not.toHaveBeenCalled();

      await act(async () => picker.resolve("C:\\picked"));
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(`/${name} C:\\picked`));
    },
  );

  it.each([false, true])(
    "refreshes commands after direct setup approval (lost response: %s)",
    async (lostResponse) => {
      const pane = client("direct-setup-refresh", 8);
      const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
      vi.mocked(pane.programmatic).mockClear();
      const hash = "a".repeat(64);
      vi.mocked(pane.programmatic).mockImplementation(async (request) => {
        if (request.action === "inspect-setup")
          return {
            version: 1,
            action: "inspect-setup",
            ok: true,
            proposal: {
              handle: hash,
              operation: "initial",
              fingerprint: hash,
              profileJson: "reviewed settings",
              configuration: {
                status: "missing",
                currentFingerprint: hash,
                refreshAvailable: false,
                baselineUnavailable: false,
                diagnostic: null,
                drift: null,
              },
              routes: [],
              exclusions: [],
              configurationInputs: [],
            },
          };
        if (request.action === "approve-setup") {
          if (lostResponse) throw new Error("fixture saved but response lost");
          return { version: 1, action: "approve-setup", ok: true, changed: true };
        }
        return report;
      });
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
      await openStep("Quick checks");
      fireEvent.click(await inStep().findByRole("button", { name: "Show suggested checks" }));
      await inStep().findByRole("button", { name: "Save checks" });
      const prior = vi.mocked(pane.listCommands).mock.calls.length;
      fireEvent.click(inStep().getByRole("button", { name: "Save checks" }));
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalledTimes(prior + 1));
      // Setup review is deterministic: no assessment request id.
      expect(pane.programmatic).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
      // Results reload by themselves after a confirmed save.
      if (!lostResponse)
        await waitFor(() =>
          expect(
            vi.mocked(pane.programmatic).mock.calls.map(([request]) => request.action),
          ).toEqual(["report", "inspect-setup", "approve-setup", "report"]),
        );
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("Check again runs only the deterministic scan, then reloads results (mocked native IPC)", async () => {
    const pane = client("check-again-reload", 8);
    const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
    if (!report.ok || report.action !== "report") throw new Error("Expected report fixture");
    report.report.scan = { available: true, reason: "Ready" };
    report.report.status = "current";
    vi.mocked(pane.programmatic).mockClear();
    vi.mocked(pane.programmatic).mockImplementation(async (request) =>
      request.action === "scan" ? { version: 1, action: "scan", ok: true, changed: true } : report,
    );
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await openStep("Review");
    const check = await screen.findByRole("button", { name: "Check again" });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    await waitFor(() =>
      expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request)).toEqual([
        { version: 1, action: "report", offset: 0 },
        { version: 1, action: "scan" },
        { version: 1, action: "report", offset: 0 },
      ]),
    );
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("blocks setup review in Plan mode but keeps report and detail access (mocked native IPC)", async () => {
    nativeMocks.realMentor = true;
    const pane = client("plan-setup-assessment", 8);
    vi.mocked(pane.getState).mockResolvedValue({ ...(await pane.getState()), planMode: true });
    const emit = liveEvents(pane);
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await openStep("Quick checks");
    const review = (await inStep().findByRole("button", {
      name: "Show suggested checks",
    })) as HTMLButtonElement;
    // Results load by themselves on open, even in Plan mode.
    await waitFor(() =>
      expect(pane.programmatic).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 }),
    );
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
    expect(review.disabled).toBe(true);
    vi.mocked(pane.programmatic).mockClear();
    fireEvent.click(review);
    // Invoke the real pane handler directly as well as the disabled control.
    await act(async () => programmaticView.onAction?.({ version: 1, action: "inspect-setup" }));
    expect(pane.programmatic).not.toHaveBeenCalled();
    await act(async () => programmaticView.onAction?.({ version: 1, action: "report", offset: 0 }));
    expect(pane.programmatic).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "report",
      offset: 0,
    });
    const id = "a".repeat(64);
    await act(async () => programmaticView.onSelect?.(id));
    expect(pane.programmatic).toHaveBeenLastCalledWith({ version: 1, action: "detail", id });
    act(() => emit("plan_exit", {}));
    await waitFor(() => expect(review.disabled).toBe(false));
    fireEvent.click(review);
    await waitFor(() =>
      expect(pane.programmatic).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" }),
    );
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("reviews unreadable setup from a loaded report without AI, save or scan permission (mocked native IPC)", async () => {
    const pane = client("unreadable-setup-assessment", 8);
    const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
    if (!report.ok || report.action !== "report") throw new Error("Expected report fixture");
    vi.mocked(pane.programmatic).mockClear();
    const error =
      "The setup could not be safely reviewed. No settings were saved; approval is unavailable.";
    vi.mocked(pane.programmatic).mockImplementation(async (request) => {
      if (request.action === "inspect-setup")
        return {
          version: 1,
          action: "inspect-setup",
          ok: false,
          reconcile: false,
          error,
        };
      return {
        ...report,
        report: {
          ...report.report,
          status: "stale",
          configuration: {
            status: "unreadable",
            currentFingerprint: null,
            refreshAvailable: false,
            baselineUnavailable: false,
            diagnostic: "Saved settings cannot be read.",
            drift: null,
          },
          scan: { available: false, reason: "Unreadable settings block scanning." },
        },
      };
    });
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await screen.findByText("Saved settings cannot be read.");
    await openStep("Quick checks");
    const review = inStep().getByRole("button", {
      name: "Show suggested checks",
    }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    fireEvent.click(review);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That didn't finish. Choose Try again when nothing else is running.",
    );
    const errorDetails = screen.getByText("Error details");
    expect(errorDetails.closest("details")!.open).toBe(false);
    fireEvent.click(errorDetails);
    expect(screen.getByText(error)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
    expect(screen.queryByLabelText("Exact settings to save")).toBeNull();
    await openStep("Review");
    const scan = screen.getByRole("button", {
      name: "Check again",
    }) as HTMLButtonElement;
    expect(scan.disabled).toBe(true);
    fireEvent.click(scan);
    expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request)).toEqual([
      { version: 1, action: "report", offset: 0 },
      { version: 1, action: "inspect-setup" },
    ]);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "failed", "cancelled"] as const)(
    "supersedes Find ideas success with slash %s status and counts (mocked native IPC)",
    async (status) => {
      nativeMocks.realMentor = true;
      const pane = client(`assessment-${status}`, 8);
      vi.mocked(pane.getState).mockResolvedValue({
        ...(await pane.getState()),
        conversationId: "conversation-1",
        sessionId: "session-1",
      });
      const emit = liveEvents(pane);
      const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
      const success = {
        version: 1 as const,
        mode: "configured" as const,
        status: "completed" as const,
        summary: "Previous button assessment",
        limitations: [],
        observations: [],
        coverage: [],
        deterministic: { status: "succeeded" as const, enabledCount: 3, applicableCount: 2 },
      };
      if (!report.ok || report.action !== "report") throw new Error("Expected report fixture");
      report.report.scan = { available: true, reason: "Ready" };
      report.report.status = "current";
      vi.mocked(pane.programmatic).mockImplementation(async (request) =>
        request.action === "discover"
          ? { version: 1, action: "discover", ok: true, assessment: success }
          : report,
      );
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
      await openStep("Find ideas");
      const find = await screen.findByRole("button", { name: "Find ideas" });
      await waitFor(() => expect((find as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(find);
      expect(await screen.findByText("3 checks set up, 2 applied.")).toBeTruthy();
      const identity = { conversationId: "conversation-1", sessionId: "session-1", sequence: 2 };
      act(() => emit("run_start", {}));
      act(() => emit("programmatic_assessment", { ...identity, phase: "started" }));
      // Previous assessment stays readable during refresh; completion replaces its counts.
      expect(screen.getByText("3 checks set up, 2 applied.")).toBeTruthy();
      const assessment = {
        ...success,
        status: status === "failed" ? "incomplete" : status,
        summary: "Latest slash assessment",
        deterministic: { status, reason: "Latest host outcome" },
      };
      act(() => emit("programmatic_assessment", { ...identity, phase: "completed", assessment }));
      act(() => emit("run_end", { outcome: "completed", runState: "idle" }));
      expect(
        await screen.findByRole("heading", {
          name: `Idea search: ${status === "failed" ? "Not finished" : status === "cancelled" ? "Stopped" : "Not available"}`,
        }),
      ).toBeTruthy();
      const details = within(screen.getByRole("region", { name: "Idea search" })).getByText(
        "Details",
      );
      if (!details.closest("details")!.open) fireEvent.click(details);
      expect(
        screen.getByRole("heading", {
          name: `Checks: ${status === "failed" ? "Failed" : status === "cancelled" ? "Stopped" : "Not available"}`,
        }),
      ).toBeTruthy();
      act(() =>
        emit("programmatic_assessment", {
          ...identity,
          sequence: 3,
          sessionId: "retired",
          phase: "completed",
          assessment: success,
        }),
      );
      act(() =>
        emit("programmatic_assessment", {
          ...identity,
          sequence: 1,
          phase: "completed",
          assessment: success,
        }),
      );
      expect(screen.queryByText("3 checks set up, 2 applied.")).toBeNull();
    },
  );

  it("surfaces a fresh slash assessment without tool activity (mocked native IPC)", async () => {
    nativeMocks.realMentor = true;
    const pane = client("fresh-assessment", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...(await pane.getState()),
      conversationId: "conversation-1",
      sessionId: "session-1",
    });
    const emit = liveEvents(pane);
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Opportunities" })).toBeNull();
    act(() => emit("run_start", {}));
    act(() =>
      emit("programmatic_assessment", {
        conversationId: "conversation-1",
        sessionId: "session-1",
        sequence: 1,
        phase: "started",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Opportunities" })).toBeTruthy();
  });

  it("shows area progress, stops through the pane cancel and refuses a stale retry (mocked native IPC)", async () => {
    nativeMocks.realMentor = true;
    const pane = client("area-progress", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...(await pane.getState()),
      conversationId: "conversation-1",
      sessionId: "session-1",
    });
    pane.cancel = vi.fn(async () => ({
      cancelled: true,
      runState: "cancelling" as const,
      drained: "",
      roadmapStatusSaved: false,
      roadmapStatusOutcome: "not-pending" as const,
      roadmapStatusRetryable: false,
    }));
    const emit = liveEvents(pane);
    const receipt = deferred<Awaited<ReturnType<PaneAgentClient["programmatic"]>>>();
    const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
    if (!report.ok || report.action !== "report") throw new Error("Expected report fixture");
    report.report.scan = { available: true, reason: "Ready" };
    report.report.status = "current";
    vi.mocked(pane.programmatic).mockClear();
    vi.mocked(pane.programmatic).mockImplementation(async (request) =>
      request.action !== "discover"
        ? report
        : request.retryArea
          ? {
              version: 1,
              action: "discover",
              ok: false,
              error: "Project files changed since this search. Search again instead.",
              reconcile: false,
            }
          : receipt.promise,
    );
    render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await openStep("Find ideas");
    const find = await screen.findByRole("button", { name: "Find ideas" });
    await waitFor(() => expect((find as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(find);
    const request = vi
      .mocked(pane.programmatic)
      .mock.calls.find(([request]) => request.action === "discover")![0];
    if (request.action !== "discover") throw new Error("Expected discovery request");
    const lifecycle = {
      conversationId: "conversation-1",
      sessionId: "session-1",
      sequence: 1,
      requestId: request.requestId,
    };
    const find1 = { need: "Release notes are hand-written", where: "docs", unsure: "Two files" };
    act(() => emit("run_start", {}));
    act(() => emit("programmatic_assessment", { ...lifecycle, phase: "started" }));
    act(() =>
      emit("programmatic_assessment", {
        ...lifecycle,
        phase: "progress",
        stage: "areas",
        areas: [
          { id: "docs", label: "docs", status: "found", finds: [find1] },
          { id: "api", label: "src/api", status: "reading" },
        ],
      }),
    );
    const areas = await screen.findByRole("list", { name: "Areas" });
    expect(within(areas).getByText("1 idea")).toBeTruthy();
    expect(within(areas).getByText("Reading")).toBeTruthy();
    // Progress keeps the search running; Stop calls the pane's own cancel and nothing else.
    fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
    expect(pane.cancel).toHaveBeenCalledTimes(1);
    act(() =>
      emit("programmatic_assessment", {
        ...lifecycle,
        phase: "progress",
        stage: "areas",
        areas: [
          { id: "docs", label: "docs", status: "found", finds: [find1] },
          { id: "api", label: "src/api", status: "stopped" },
        ],
      }),
    );
    const stopped = {
      version: 1 as const,
      lifecycle,
      mode: "configured" as const,
      status: "cancelled" as const,
      summary: "Search stopped.",
      limitations: [],
      coverage: [],
      observations: [],
      deterministic: { status: "succeeded" as const, enabledCount: 1, applicableCount: 1 },
      areas: [
        { id: "docs", label: "docs", status: "searched" as const, retryable: false },
        {
          id: "api",
          label: "src/api",
          status: "not-searched" as const,
          reason: "cancelled" as const,
          retryable: true,
        },
      ],
    };
    act(() =>
      emit("programmatic_assessment", { ...lifecycle, phase: "completed", assessment: stopped }),
    );
    await act(async () =>
      receipt.resolve({ version: 1, action: "discover", ok: true, assessment: stopped }),
    );
    act(() => emit("run_end", { outcome: "cancelled", runState: "idle" }));
    const early = screen.getByRole("region", { name: "Early finds", hidden: true });
    expect(within(early).getByText(/Stopped before checking/)).toBeTruthy();
    expect(within(early).queryByRole("button", { hidden: true })).toBeNull();
    await openStep("Find ideas");
    const retry = await screen.findByRole("button", { name: "Try src/api again" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    expect(
      await screen.findByText("Project files changed since this search. Search again instead."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try src/api again" })).toBeNull();
    const discovers = vi
      .mocked(pane.programmatic)
      .mock.calls.map(([request]) => request)
      .filter((request) => request.action === "discover");
    expect(discovers).toEqual([
      { version: 1, action: "discover", requestId: request.requestId },
      {
        version: 1,
        action: "discover",
        retryArea: { sequence: 1, areaId: "api" },
        requestId: expect.any(String),
      },
    ]);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["success", "transport-lost"] as const)(
    "programmatic discovery settles dropped completion as %s without replay and maps explicit review (mocked native IPC)",
    async (outcome) => {
      nativeMocks.realMentor = true;
      const pane = client("discovery-dropped-completion", 8);
      vi.mocked(pane.getState).mockResolvedValue({
        ...(await pane.getState()),
        conversationId: "conversation-1",
        sessionId: "session-1",
      });
      const emit = liveEvents(pane);
      const receipt = deferred<Awaited<ReturnType<PaneAgentClient["programmatic"]>>>();
      const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
      vi.mocked(pane.programmatic).mockClear();
      vi.mocked(pane.programmatic).mockImplementation(async (request) =>
        request.action === "discover" ? receipt.promise : report,
      );
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
      await openStep("Find ideas");
      const discover = await screen.findByRole("button", { name: "Find ideas" });
      await waitFor(() => expect((discover as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(discover);
      const request = vi
        .mocked(pane.programmatic)
        .mock.calls.find(([request]) => request.action === "discover")![0];
      if (request.action !== "discover") throw new Error("Expected discovery request");
      expect(request.requestId).toEqual(expect.any(String));
      const lifecycle = {
        conversationId: "conversation-1",
        sessionId: "session-1",
        sequence: 1,
        requestId: request.requestId,
      };
      act(() => emit("programmatic_assessment", { ...lifecycle, phase: "started" }));
      expect(await screen.findByText(/Looking for ideas/)).toBeTruthy();
      // No completed event is delivered. No new provider request is allowed to repair it.
      if (outcome === "transport-lost") {
        await act(async () => receipt.reject(new Error("Transport cancelled")));
        expect(await screen.findByText(/We couldn't tell if the search finished/)).toBeTruthy();
      } else {
        const candidate = {
          assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742",
          candidateId: "ad5bb9ba-4d86-485a-8d74-613fe59b12df",
          revision: 1,
          choice: "missing-capability" as const,
          outcome: "Inspect recurring records",
          rationale: "Repeated",
          uncertainty: "Scoped",
          workflow: {
            trigger: "Change",
            representativeCase: "Record",
            inputs: [],
            currentProcess: [],
            output: "Report",
            successCheck: "Find issue",
            scope: "Project",
            mutationBoundary: "Read-only",
            repeatability: { basis: "inferred" as const, explanation: "Recurring" },
          },
          evidence: [],
          alternatives: [],
          risks: [],
          details: [],
          nextStep: { available: true, reason: "Review only" },
        };
        await act(async () =>
          receipt.resolve({
            version: 1,
            action: "discover",
            ok: true,
            assessment: {
              version: 1,
              mode: "setup",
              status: "completed",
              summary: "Recovered discovery",
              lifecycle,
              limitations: [],
              observations: [],
              coverage: [],
              deterministic: { status: "not-run", reason: "setup" },
              discovery: { assessmentId: candidate.assessmentId, candidates: [candidate] },
            },
          }),
        );
        await openStep("Review");
        fireEvent.click(await screen.findByRole("button", { name: candidate.outcome }));
        expect(
          (screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement).disabled,
        ).toBe(false);
        expect(screen.getAllByText(candidate.rationale)).toHaveLength(1);
        expect(document.activeElement).toBe(
          document.querySelector("[data-programmatic-selection]"),
        );
        expect(
          screen.getByRole("button", { name: candidate.outcome }).getAttribute("aria-pressed"),
        ).toBe("true");
        expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request.action)).toEqual([
          "report",
          "discover",
        ]);
        vi.mocked(pane.programmatic).mockResolvedValueOnce({
          version: 1,
          action: "review-candidate",
          ok: true,
          candidateReview: {
            status: "prepared",
            candidate,
            summary: "Review prepared without execution",
          },
        });
        fireEvent.click(screen.getByRole("button", { name: "Review this idea" }));
        await waitFor(() =>
          expect(pane.programmatic).toHaveBeenLastCalledWith({
            version: 1,
            action: "review-candidate",
            intent: "review-only",
            source: "current",
            assessmentId: candidate.assessmentId,
            candidateId: candidate.candidateId,
            expectedRevision: candidate.revision,
          }),
        );
        expect(await screen.findByText("Review ready. Nothing was changed.")).toBeTruthy();
        expect(screen.getAllByText(candidate.rationale)).toHaveLength(1);
      }
      expect(screen.queryByText(/Looking for ideas/)).toBeNull();
      expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request.action)).toEqual(
        outcome === "success" ? ["report", "discover", "review-candidate"] : ["report", "discover"],
      );
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "typed setup review queues one deterministic inspect-setup after results load (typed: %s, mocked native IPC)",
    async (typed) => {
      nativeMocks.realMentor = true;
      const pane = client("typed-setup-review", 8);
      vi.mocked(pane.getState).mockResolvedValue({
        ...(await pane.getState()),
        conversationId: "conversation-1",
        sessionId: "session-1",
      });
      const emit = liveEvents(pane);
      const report = await pane.programmatic({ version: 1, action: "report", offset: 0 });
      vi.mocked(pane.programmatic).mockClear();
      const hash = "a".repeat(64);
      vi.mocked(pane.programmatic).mockImplementation(async (request) =>
        request.action === "inspect-setup"
          ? {
              version: 1,
              action: "inspect-setup",
              ok: true,
              proposal: {
                handle: hash,
                operation: "initial",
                fingerprint: hash,
                profileJson: "exact reviewed settings",
                configuration: {
                  status: "missing",
                  currentFingerprint: hash,
                  refreshAvailable: false,
                  baselineUnavailable: false,
                  diagnostic: null,
                  drift: null,
                },
                routes: [],
                exclusions: [],
                configurationInputs: [],
              },
            }
          : report,
      );
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
      await waitFor(() => expect(pane.programmatic).toHaveBeenCalledTimes(1));
      // A typed /setup-programmatic carries no panel request id; Find ideas always does.
      const identity = {
        conversationId: "conversation-1",
        sessionId: "session-1",
        sequence: 1,
        ...(typed ? {} : { requestId: "12345678-1234-4234-8234-123456789abc" }),
      };
      act(() => emit("run_start", {}));
      act(() => emit("programmatic_assessment", { ...identity, phase: "started" }));
      act(() =>
        emit("programmatic_assessment", {
          ...identity,
          phase: "completed",
          assessment: {
            version: 1,
            mode: "setup",
            status: "completed",
            summary: "Setup reviewed",
            limitations: [],
            coverage: [],
            observations: [],
            deterministic: { status: "not-run", reason: "setup" },
          },
        }),
      );
      act(() => emit("run_end", { outcome: "completed", runState: "idle" }));
      act(() =>
        emit("ready", {
          running: false,
          runState: "idle",
          conversationId: "conversation-1",
          sessionId: "session-1",
        }),
      );
      const actions = () => vi.mocked(pane.programmatic).mock.calls.map(([request]) => request);
      if (typed) {
        await waitFor(() =>
          expect(actions()).toEqual([
            { version: 1, action: "report", offset: 0 },
            { version: 1, action: "report", offset: 0 },
            { version: 1, action: "inspect-setup" },
          ]),
        );
        await openStep("Quick checks");
        expect(await screen.findByText("exact reviewed settings")).toBeTruthy();
        expect(
          (inStep().getByRole("button", { name: "Save checks" }) as HTMLButtonElement).disabled,
        ).toBe(false);
      } else {
        await waitFor(() => expect(actions().length).toBeGreaterThanOrEqual(2));
        await act(async () => {});
        expect(actions().every((request) => request.action === "report")).toBe(true);
      }
      // Inspecting is read-only; saving still needs the click.
      expect(actions().some((request) => request.action === "approve-setup")).toBe(false);
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("opens one code-only opportunity section without changing the composer draft", async () => {
    const pane = client("pane-opportunities", 8);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await waitFor(() =>
      expect(pane.programmatic).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 }),
    );
    expect(screen.getAllByRole("heading", { name: "Opportunities" })).toHaveLength(1);
    expect((input as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    await openStep("Review");
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
    expect(pane.programmatic).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("heading", { name: "Opportunities" })).toHaveLength(1);
  });

  it("switches the action button to Post-check and sends its commands in order, stopping at a failure", async () => {
    const pane = client("pane-post-check", 8);
    vi.mocked(pane.listCommands).mockResolvedValue(
      ["trace", "parity", "contract"].map((name) => ({
        name,
        aliases: [],
        description: name,
        input: { text: "optional", references: "optional", attachments: "optional" },
        source: "custom",
      })) as Awaited<ReturnType<PaneAgentClient["listCommands"]>>,
    );
    const first = deferred<{ queued: false; count: 0 }>();
    vi.mocked(pane.sendPrompt)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ queued: true, count: 1, queueId: "q1", steers: false })
      .mockResolvedValueOnce({ queued: true, count: 2, queueId: "q2", steers: false });
    try {
      render(<AgentPane client={pane} target={target} />);
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: "Keep this draft" } });

      // Picking an option only switches the button.
      const hub = screen.getByRole("button", { name: "Opportunities" });
      fireEvent.keyDown(hub, { key: "ArrowUp" });
      fireEvent.keyDown(hub, { key: "ArrowRight" });
      fireEvent.keyDown(hub, { key: "Enter" });
      fireEvent.click(hub);
      expect(screen.getByRole("button", { name: "Post-check" })).toBe(hub);
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      expect(pane.programmatic).not.toHaveBeenCalled();
      await waitFor(() => expect(hub.getAttribute("aria-disabled")).toBeNull());

      fireEvent.click(hub);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(1));
      // /parity waits for /trace's receipt, so the sidecar queues them in order.
      expect(pane.sendPrompt).toHaveBeenLastCalledWith("/trace");
      await act(async () => first.resolve({ queued: false, count: 0 }));
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(3));
      expect(vi.mocked(pane.sendPrompt).mock.calls.map(([text]) => text)).toEqual([
        "/trace",
        "/parity",
        "/contract",
      ]);
      expect((input as HTMLTextAreaElement).value).toBe("Keep this draft");
      await waitFor(() => expect(hub.getAttribute("aria-disabled")).toBeNull());

      // A rejected step stops the rest of the sequence.
      vi.mocked(pane.sendPrompt)
        .mockResolvedValueOnce({ queued: false, count: 0 })
        .mockRejectedValueOnce(
          new PromptSubmissionError({ code: "workflow_busy", message: "busy" }),
        );
      fireEvent.click(hub);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(5));
      await waitFor(() => expect(hub.getAttribute("aria-disabled")).toBeNull());
      expect(pane.sendPrompt).toHaveBeenCalledTimes(5);
      expect(vi.mocked(pane.sendPrompt).mock.calls.at(-1)?.[0]).toBe("/parity");
    } finally {
      localStorage.removeItem("gg-composer-action");
    }
  });

  // Regression: only a live question makes a prompt steer (sidecar
  // promptSteersRun), so a deferred one must not block Post-check.
  it("blocks Post-check on a live question but runs it once the question is deferred", async () => {
    nativeMocks.realMentor = true; // Use the real event hook so ask events render cards.
    const pane = client("pane-post-check-ask", 8);
    const emit = liveEvents(pane);
    vi.mocked(pane.listCommands).mockResolvedValue(
      ["trace", "parity", "contract"].map((name) => ({
        name,
        aliases: [],
        description: name,
        input: { text: "optional", references: "optional", attachments: "optional" },
        source: "custom",
      })) as Awaited<ReturnType<PaneAgentClient["listCommands"]>>,
    );
    vi.mocked(pane.sendPrompt)
      .mockResolvedValueOnce({ queued: false, count: 0 })
      .mockResolvedValueOnce({ queued: true, count: 1, queueId: "q1", steers: false })
      .mockResolvedValueOnce({ queued: true, count: 2, queueId: "q2", steers: false });
    try {
      render(<AgentPane client={pane} target={target} />);
      await screen.findByRole("textbox");
      await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
      await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
      const hub = screen.getByRole("button", { name: "Opportunities" });
      fireEvent.keyDown(hub, { key: "ArrowUp" });
      fireEvent.keyDown(hub, { key: "ArrowRight" });
      fireEvent.keyDown(hub, { key: "Enter" });
      fireEvent.click(hub); // The click that follows a keyboard pick is swallowed.
      expect(screen.getByRole("button", { name: "Post-check" })).toBe(hub);
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      await waitFor(() => expect(hub.getAttribute("aria-disabled")).toBeNull());

      act(() => {
        emit("ask_user", {
          id: "ask-1",
          questions: [
            {
              id: "approval",
              kind: "choice",
              question: "Allow this action?",
              options: [{ label: "Allow action", value: "allow" }],
            },
          ],
        });
      });
      await screen.findByRole("button", { name: /Allow action/ });
      fireEvent.click(hub);
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        "Answer the open question before running Post-check.",
        "warning",
      );
      expect(pane.sendPrompt).not.toHaveBeenCalled();

      act(() => emit("ask_user_deferred", { id: "ask-1" }));
      nativeMocks.toast.mockClear();
      fireEvent.click(hub);
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/trace"));
      await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(3));
      expect(nativeMocks.toast).not.toHaveBeenCalledWith(
        "Answer the open question before running Post-check.",
        "warning",
      );
    } finally {
      localStorage.removeItem("gg-composer-action");
    }
  });

  async function deferredOpportunityRun(
    completeBeforeReceipt = true,
    configurePane?: (pane: PaneAgentClient) => void,
  ) {
    nativeMocks.realMentor = true;
    const pane = client("pane-opportunity-race", 8);
    const emit = liveEvents(pane);
    configurePane?.(pane);
    const receipt = deferred<Awaited<ReturnType<PaneAgentClient["sendPrompt"]>>>();
    vi.mocked(pane.sendPrompt).mockReturnValue(receipt.promise);
    const id = "a".repeat(64);
    let completed = false;
    vi.mocked(pane.programmatic).mockImplementation(async (request) => {
      const summary = {
        id,
        expectedOutput: "Review packaging",
        state: completed ? ("completed" as const) : ("discovered" as const),
        presence: "present" as const,
        mutationPaths: [],
        actions: {
          run: { available: !completed, reason: completed ? "Completed" : "Can run" },
          dismiss: { available: !completed, reason: completed ? "Completed" : "Can dismiss" },
        },
        route: {
          available: !completed,
          command: "research" as const,
          reason: completed ? "Execution completed" : "Available",
          machineLocal: true,
        },
      };
      const snapshot = (completed ? "b" : "a").repeat(64);
      if (request.action === "report")
        return {
          version: 1,
          action: "report",
          ok: true,
          report: {
            status: "current",
            reason: "Current",
            scan: { available: true, reason: "Approved" },
            snapshot,
            fingerprint: id,
            offset: 0,
            total: 1,
            rows: [summary],
          },
        };
      if (request.action === "detail")
        return {
          version: 1,
          action: "detail",
          ok: true,
          snapshot,
          detail: {
            summary,
            trigger: "Manifest change",
            verification: completed ? "Verified completion" : "Not yet run",
            risks: [],
            evidence: [],
            evidenceTruncated: false,
          },
        };
      throw new Error(`Unexpected mutation: ${request.action}`);
    });
    const view = render(<AgentPane client={pane} target={target} />);
    await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
    await waitFor(() => expect(pane.programmatic).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Opportunities" })).toBeTruthy();
    await openStep("Review");
    fireEvent.click(await screen.findByRole("button", { name: /Review packaging/ }));
    const run = await screen.findByRole("button", { name: "Review and run" });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(pane.sendPrompt).toHaveBeenCalledExactlyOnceWith(`/programmatic-run ${id} ${id}`);
    if (!completeBeforeReceipt) return { pane, emit, receipt, view, id };
    act(() => emit("run_start", {}));
    completed = true;
    act(() => emit("run_end", { outcome: "completed", runState: "idle" }));
    act(() => emit("agent_done", {}));
    act(() => emit("ready", { running: false, runState: "idle" }));
    act(() => emit("run_end", { outcome: "completed", runState: "idle" }));
    expect(pane.programmatic).toHaveBeenCalledTimes(2);
    return { pane, emit, receipt, view, id };
  }

  it("renders specialist approval buffered during pane identity lookup across a run receipt", async () => {
    const realAgent = await vi.importActual<typeof AgentModule>("./agent");
    const identity = deferred<AgentModule.PaneStartupStatus>();
    nativeMocks.invoke.mockImplementation(async (command) => {
      if (command === "agent_pane_status") return identity.promise;
      return undefined;
    });
    const { pane, receipt } = await deferredOpportunityRun(false, (pane) => {
      pane.subscribe = realAgent.createPaneAgentClient(pane.paneId).subscribe;
    });
    const question = {
      id: "ask-1",
      questions: [
        {
          id: "specialist-approval",
          kind: "choice",
          question: "Allow /research to work on this task?",
          allowOther: false,
          options: [
            { label: "Approve and start task", value: "approved-snapshot" },
            { label: "Cancel", value: "cancel", recommended: true },
          ],
        },
      ],
    };
    expect(nativeMocks.agentEvent).not.toBeNull();
    act(() =>
      nativeMocks.agentEvent!({
        payload: {
          paneId: pane.paneId,
          sessionId: "opportunity-session",
          type: "ask_user",
          data: question,
        },
      }),
    );
    // The real transport buffers the frame until native identity resolves.
    expect(screen.queryByText(question.questions[0].question)).toBeNull();
    await act(async () => receipt.resolve({ queued: false, count: 0 }));
    await act(async () =>
      identity.resolve({
        ready: true,
        error: null,
        generation: 8,
        sessionId: "opportunity-session",
      }),
    );
    expect(await screen.findByText(question.questions[0].question)).toBeTruthy();
    expect(pane.answerAskUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve and start task" }));
    await waitFor(() =>
      expect(pane.answerAskUser).toHaveBeenCalledExactlyOnceWith("ask-1", "answer", {
        "specialist-approval": "approved-snapshot",
      }),
    );
  });

  it.each(["programmatic_execution_busy", "invalid_programmatic_selection"])(
    "shows definite %s rejection without uncertain reconciliation or retry",
    async (code) => {
      const { pane, receipt } = await deferredOpportunityRun(false);
      await act(async () =>
        receipt.reject(
          new PromptSubmissionError({
            category: "rejected",
            code,
            message: "Wait for the current run to finish.",
          }),
        ),
      );
      expect(
        await screen.findByText("Couldn't start: Wait for the current run to finish."),
      ).toBeTruthy();
      expect(screen.queryByText(/We couldn't tell if it started/)).toBeNull();
      expect(
        (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(pane.programmatic).toHaveBeenCalledTimes(2);
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["Network response lost", "invalid prompt submission response"])(
    "keeps %s uncertain without retrying execution",
    async (message) => {
      const { pane, receipt } = await deferredOpportunityRun(false);
      await act(async () => receipt.reject(new PromptSubmissionError(new Error(message))));
      expect(await screen.findByText(/We couldn't tell if it started/)).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it("coalesces terminal invalidations before a deferred opportunity receipt into report and detail refresh", async () => {
    const { pane, receipt, id } = await deferredOpportunityRun();
    await act(async () => receipt.resolve({ queued: false, count: 0 }));
    await waitFor(() => expect(pane.programmatic).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("Verified completion")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Review packaging.*Done/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request)).toEqual([
      { version: 1, action: "report", offset: 0 },
      { version: 1, action: "detail", id },
      { version: 1, action: "report", offset: 0 },
      { version: 1, action: "detail", id },
    ]);
    expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "uncertain"] as const)(
    "refreshes authoritative completion after a %s opportunity receipt without retrying the run",
    async (outcome) => {
      const { pane, receipt, id } = await deferredOpportunityRun();
      await act(async () => {
        if (outcome === "rejected") receipt.reject(new Error("Opportunity run rejected"));
        else receipt.reject(new Error("Native acknowledgement lost"));
      });
      expect(await screen.findByText("Verified completion")).toBeTruthy();
      expect(vi.mocked(pane.programmatic).mock.calls.map(([request]) => request)).toEqual([
        { version: 1, action: "report", offset: 0 },
        { version: 1, action: "detail", id },
        { version: 1, action: "report", offset: 0 },
        { version: 1, action: "detail", id },
      ]);
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "discards queued opportunity refresh on unmount before receipt %s",
    async (outcome) => {
      const { pane, receipt, view } = await deferredOpportunityRun();
      view.unmount();
      await act(async () => {
        if (outcome === "resolve") receipt.resolve({ queued: false, count: 0 });
        else receipt.reject(new Error("Late acknowledgement failure"));
      });
      expect(pane.programmatic).toHaveBeenCalledTimes(2);
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "does not drain a reset session's queued opportunity refresh on receipt %s",
    async (outcome) => {
      const { pane, receipt, emit } = await deferredOpportunityRun();
      act(() => emit("session_reset", {}));
      expect(screen.queryByRole("heading", { name: "Opportunities" })).toBeNull();
      // A new report owner must survive the old receipt's finally block.
      const report = deferred<Awaited<ReturnType<PaneAgentClient["programmatic"]>>>();
      vi.mocked(pane.programmatic).mockReturnValueOnce(report.promise);
      fireEvent.click(screen.getByRole("button", { name: "Opportunities" }));
      expect(pane.programmatic).toHaveBeenCalledTimes(3);
      await act(async () => {
        if (outcome === "resolve") receipt.resolve({ queued: false, count: 0 });
        else receipt.reject(new Error("Late acknowledgement failure"));
      });
      expect(pane.programmatic).toHaveBeenCalledTimes(3);
      await act(async () =>
        report.resolve({
          version: 1,
          action: "report",
          ok: true,
          report: {
            status: "current",
            reason: "Fresh session report",
            scan: { available: true, reason: "Approved" },
            snapshot: "c".repeat(64),
            fingerprint: "c".repeat(64),
            offset: 0,
            total: 0,
            rows: [],
          },
        }),
      );
      expect(await screen.findByText("Fresh session report")).toBeTruthy();
      expect(screen.queryByText("Verified completion")).toBeNull();
      expect(pane.programmatic).toHaveBeenCalledTimes(3);
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it("does not expose opportunities in chat mode", async () => {
    const pane = client("pane-chat-opportunities", 8);
    render(<AgentPane client={pane} target={{ ...target, mode: "chat" }} />);
    await screen.findByRole("textbox");
    expect(screen.queryByRole("button", { name: "Opportunities" })).toBeNull();
    expect(pane.programmatic).not.toHaveBeenCalled();
  });

  it("retains pasted programmatic references with zero chips without sending", async () => {
    const pane = client("pane-pasted-references", 8);
    const commands: AgentModule.SlashCommand[] = [
      {
        name: "programmatic",
        aliases: [],
        description: "Scan",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ];
    vi.mocked(pane.listCommands).mockResolvedValue(commands);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const draft = "/programmatic focus\n\nReferenced files:\n- src/example.ts";
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(await screen.findByText("Command input blocked")).toBeTruthy();
    expect(screen.getByText(/does not accept file references/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe(draft);
    expect(noInputSlashSubmissionError(draft, commands, 0, 0)).toContain("file references");
    expect(noInputSlashSubmissionError("/programmatic focus", commands, 0, 1)).toContain(
      "file references",
    );
  });

  it("sends pasted references unchanged for custom commands allowing references", async () => {
    const pane = client("pane-allowed-references", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "custom-review",
        aliases: [],
        description: "Review",
        input: { text: "optional", references: "optional", attachments: "optional" },
        source: "custom",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const draft = "/custom-review focus\n\nReferenced files:\n- src/example.ts";
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(draft, [], undefined));
    expect(screen.queryByText("Command input blocked")).toBeNull();
  });

  it.each([
    ["overlong trimmed focus", `  ${"x".repeat(4_001)}  `],
    ["NUL", "check\u0000tests"],
    ["C0 control", "check\u001ftests"],
    ["DEL", "check\u007ftests"],
    ["C1 control", "check\u0085tests"],
  ])("retains invalid programmatic %s without sending", async (_label, focus) => {
    const pane = client("pane-invalid-focus", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const draft = `/programmatic ${focus}`;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Command input blocked")).toBeTruthy();
    expect(screen.getByText(/optional focus of at most 4,000 characters/)).toBeTruthy();
    expect(screen.getByText(/newlines and tabs are allowed/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe(draft);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(pane.programmatic).not.toHaveBeenCalled();
  });

  it.each([
    ["4,000 trimmed UTF-16 units", `  ${"😀".repeat(2_000)}  `],
    ["Unicode, multiline and tabs", "检查 café 😀\nnext\tstep"],
    ["literal reference heading without a block", "focus\n\nReferenced files:\nnot a chip"],
    ["empty focus", ""],
    ["whitespace-only focus", " \t\n "],
  ])("sends valid programmatic %s unchanged apart from outer trim", async (_label, focus) => {
    const pane = client("pane-valid-focus", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const draft = `/programmatic ${focus}`;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(draft.trim(), [], undefined));
    expect(screen.queryByText("Command input blocked")).toBeNull();
  });

  it.each([
    ["ordinary chat", "code", "hello", "built-in"],
    ["custom command", "code", "/programmatic", "custom"],
    ["non-code custom command", "chat", "/programmatic", "custom"],
    ["hidden built-in direct guidance", "code", "/programmatic", "hidden"],
  ] as const)("leaves %s submission ownership unchanged", async (_label, mode, prefix, source) => {
    const pane = client("pane-focus-ownership", 8);
    vi.mocked(pane.listCommands).mockResolvedValue(
      source === "hidden"
        ? []
        : [
            {
              name: "programmatic",
              aliases: [],
              description: "Scan",
              input: { text: "optional", references: "optional", attachments: "optional" },
              source,
            },
          ],
    );
    render(<AgentPane client={pane} target={{ ...target, mode }} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    const draft = `${prefix} ${"x".repeat(4_001)}\u0000`;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith(draft, [], undefined));
    expect(screen.queryByText("Command input blocked")).toBeNull();
  });

  it("accepts CR/LF/tab focus and rejects attachments and references with optional focus", () => {
    const commands: AgentModule.SlashCommand[] = [
      {
        name: "programmatic",
        aliases: [],
        description: "Scan",
        input: { text: "optional", references: "none", attachments: "none" },
        source: "built-in",
      },
    ];
    const draft = "/programmatic 检查\r\nnext\tstep";
    // Textareas normalize CR to LF; exercise the validator directly for CR parity.
    expect(noInputSlashSubmissionError(draft, commands, 0, 0)).toBeNull();
    expect(noInputSlashSubmissionError(draft, commands, 1, 0)).toContain("attachments");
    expect(noInputSlashSubmissionError(draft, commands, 0, 1)).toContain("file references");
  });

  it("inserts fixed-input commands exactly and disables composer additions", async () => {
    const pane = client("pane-no-input-select", 8);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan programmatic opportunities",
        input: { text: "none", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.click(await screen.findByText("/programmatic"));

    expect((input as HTMLTextAreaElement).value).toBe("/programmatic");
    expect((input as HTMLTextAreaElement).readOnly).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/programmatic", [], undefined),
    );
  });

  it("blocks malformed fixed-input submissions with actionable guidance", async () => {
    const pane = client("pane-no-input-submit", 9);
    vi.mocked(pane.listCommands).mockResolvedValue([
      {
        name: "programmatic",
        aliases: [],
        description: "Scan programmatic opportunities",
        input: { text: "none", references: "none", attachments: "none" },
        source: "built-in",
      },
    ]);
    render(<AgentPane client={pane} target={target} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "/programmatic caller instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Command input blocked")).toBeTruthy();
    expect(screen.getByText(/does not accept additional text/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("/programmatic");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each([
    [
      "arguments",
      "/programmatic caller instructions",
      { text: "none", references: "optional", attachments: "optional" } as const,
      0,
      0,
      "additional text",
    ],
    [
      "attachments",
      "/programmatic",
      { text: "optional", references: "optional", attachments: "none" } as const,
      1,
      0,
      "attachments",
    ],
    [
      "referenced files",
      "/programmatic",
      { text: "optional", references: "none", attachments: "optional" } as const,
      0,
      1,
      "file references",
    ],
  ])(
    "independently rejects fixed-input submission %s",
    (_kind, text, inputPolicy, attachments, references, expected) => {
      expect(
        noInputSlashSubmissionError(
          text,
          [
            {
              name: "programmatic",
              aliases: [],
              description: "Scan",
              input: inputPolicy,
              source: "built-in",
            },
          ],
          attachments,
          references,
        ),
      ).toContain(expected);
    },
  );

  it("rehydrates a persisted plan review before any SSE event", async () => {
    const pane = client("pane-plan-restart", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-restart",
        generation: 5,
        planPath: "/plans/restart.md",
        content: "## Steps\n1. Verify restart hydration",
        contentHash: "hash",
        state: "pending-review",
        reviewStatus: "ready",
        feedback: "Corpus unavailable. Review this limitation before approval.",
      },
    });
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(await screen.findByText(/Your approval is still required/i)).toBeTruthy();
    expect(
      screen.getByText("Corpus unavailable. Review this limitation before approval."),
    ).toBeTruthy();
    expect(pane.acceptPlan).not.toHaveBeenCalled();
    expect(pane.revisePlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-restart", 5));
  });

  it("replaces a stale accepted checkpoint with the backend checkpoint", async () => {
    const pane = client("pane-plan-stale-accept", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-old",
        generation: 2,
        planPath: "/plans/old.md",
        content: "## Old plan",
        contentHash: "old-hash",
        state: "pending-review",
        reviewStatus: "unreviewed",
        feedback: null,
      },
    });
    const latest = {
      checkpointId: "checkpoint-latest",
      generation: 3,
      planPath: "/plans/latest.md",
      content: "## Latest backend plan",
      contentHash: "latest-hash",
      state: "pending-review" as const,
      reviewStatus: "ready" as const,
      feedback: null,
    };
    vi.mocked(pane.acceptPlan).mockRejectedValue(
      new PlanMutationError(
        "The plan changed before this action completed. Review the latest checkpoint and try again.",
        { error: "stale-plan-checkpoint", pendingPlanReview: latest },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await screen.findByText("Latest backend plan");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(screen.getByText("Latest backend plan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Review the latest checkpoint"),
      "error",
      7_000,
    );
  });

  it("replaces a stale revision request with the backend checkpoint", async () => {
    const pane = client("pane-plan-stale-revise", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-old",
        generation: 4,
        planPath: "/plans/old.md",
        content: "## Old revision target",
        contentHash: "old-hash",
        state: "pending-review",
        reviewStatus: "unreviewed",
        feedback: null,
      },
    });
    const latest = {
      checkpointId: "checkpoint-latest",
      generation: 5,
      planPath: "/plans/latest.md",
      content: "## Latest revision target",
      contentHash: "latest-hash",
      state: "revision-requested" as const,
      reviewStatus: "ready" as const,
      feedback: "Preserve the recovery contract",
    };
    vi.mocked(pane.revisePlan).mockRejectedValue(
      new PlanMutationError(
        "The plan changed before this action completed. Review the latest checkpoint and try again.",
        { error: "stale-plan-checkpoint", pendingPlanReview: latest },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Feedback" }));
    fireEvent.change(screen.getByPlaceholderText("What should change about this plan?"), {
      target: { value: "Revise this plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await screen.findByText("Latest revision target");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(screen.getByText("Latest revision target")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry revision" })).toBeTruthy();
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Review the latest checkpoint"),
      "error",
      7_000,
    );
  });

  it("keeps the gate open and shows actionable checkpoint failure guidance", async () => {
    const pane = client("pane-plan-checkpoint-failure", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-failure",
        generation: 7,
        planPath: "/plans/failure.md",
        content: "## Plan remains authoritative",
        contentHash: "failure-hash",
        state: "pending-review",
        reviewStatus: "ready",
        feedback: null,
      },
    });
    vi.mocked(pane.acceptPlan).mockRejectedValue(
      new PlanMutationError(
        "Could not persist the phase checkpoint. Fix Project Notes permissions, then retry.",
        {
          status: "failed",
          operationId: "operation-7",
          code: "checkpoint-write-failed",
          message: "Could not persist the phase checkpoint.",
          guidance: "Fix Project Notes permissions, then retry.",
          retryable: true,
          phaseId: "phase-1",
        },
      ),
    );
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(nativeMocks.toast).toHaveBeenCalledWith(
        "Could not persist the phase checkpoint. Fix Project Notes permissions, then retry.",
        "error",
        7_000,
      ),
    );
    expect(screen.getByText("Plan remains authoritative")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("retries the exact persisted revision after restart while prompts stay blocked", async () => {
    const pane = client("pane-plan-revision-retry", 8);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("gpt-test"),
      pendingPlanReview: {
        checkpointId: "checkpoint-revision-retry",
        generation: 6,
        planPath: "/plans/retry.md",
        content: "## Steps\n1. Recover the revision run",
        contentHash: "hash",
        state: "revision-requested",
        reviewStatus: "ready",
        feedback: "Add crash recovery coverage",
      },
    });
    render(<AgentPane client={pane} target={target} />);

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(await screen.findByRole("button", { name: "Retry revision" })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry revision" }));
    await waitFor(() =>
      expect(pane.revisePlan).toHaveBeenCalledWith(
        "checkpoint-revision-retry",
        6,
        "Add crash recovery coverage",
      ),
    );
  });

  it("sends checkpoint identity for ordinary plan acceptance without a prompt bypass", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false),
    );
    const handleEvent = paneEvents(pane);

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-ordinary",
          generation: 4,
          planPath: "/plans/ordinary.md",
          content: "## Steps\n1. Build\n2. Verify",
        },
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-ordinary", 4));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("holds an implemented /commit action at the inline plan gate, then resumes after approval", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });

    const continueButton = await renderKenPromptPane(pane, false, "/commit");
    const handleEvent = paneEvents(pane);
    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/commit", [], { kenSent: true }),
    );
    vi.mocked(pane.sendPrompt).mockClear();

    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-commit",
          generation: 2,
          planPath: "/plans/blocked-commit.md",
          content: "## Steps\n1. Build\n2. Verify",
        },
      }),
    );

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    expect(await screen.findByRole("region", { name: "Plan approval required" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(continueButton);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-commit", 2));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Plan approval required" })).toBeNull();
  });

  it("keeps the active approval-resume prompt when later steering is queued", async () => {
    const pane = client("pane-1", 7);
    vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "assistant", text: "```prompt\n/commit\n```", ken: true },
      { role: "assistant", text: "```prompt\nqueued steering\n```", ken: true },
    ] as Awaited<ReturnType<PaneAgentClient["listHistory"]>>);
    vi.mocked(pane.sendPrompt)
      .mockResolvedValueOnce({ queued: false, count: 0 })
      .mockResolvedValueOnce({ queued: true, count: 1, queueId: "q1", steers: false });
    vi.mocked(pane.acceptPlan).mockResolvedValue({
      ok: true,
      planTotal: 2,
      operationId: "plan-accept-test",
    });

    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    const continueButtons = await screen.findAllByRole("button", { name: "Continue here" });
    fireEvent.click(continueButtons[0]!);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("/commit", [], { kenSent: true }),
    );
    fireEvent.click(continueButtons[1]!);
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith("queued steering", [], { kenSent: true }),
    );
    vi.mocked(pane.sendPrompt).mockClear();

    const handleEvent = paneEvents(pane);
    act(() =>
      handleEvent?.({
        type: "plan_exit",
        data: {
          checkpointId: "checkpoint-active",
          generation: 3,
          planPath: "/plans/active-commit.md",
          content: "## Steps\n1. Commit",
        },
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("region", { name: "Pending reviews" })).getByRole("button", {
        name: /^Plan approval required/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(pane.acceptPlan).toHaveBeenCalledWith("checkpoint-active", 3));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("managed panes restore an existing native session without owning its disposal", async () => {
    const pane = client("pane-1", 7);
    const view = render(
      <AgentPane
        client={pane}
        target={target}
        workspaceOwnsSessionLifecycle
        reclaimNativeSession
      />,
    );
    await waitFor(() => expect(pane.restore).toHaveBeenCalledWith(target));
    expect(pane.create).not.toHaveBeenCalled();
    view.unmount();
    expect(pane.dispose).not.toHaveBeenCalled();
  });

  it("does not restart or dispose when generation callback updates parent", async () => {
    const pane = client("pane-1", 7);
    function Harness() {
      const [generation, setGeneration] = useState<number | null>(null);
      return (
        <AgentPane
          client={pane}
          target={target}
          generation={generation}
          onGenerationChange={setGeneration}
        />
      );
    }
    const view = render(<Harness />);
    await waitFor(() => expect(pane.create).toHaveBeenCalledTimes(1));
    expect(pane.restore).not.toHaveBeenCalled();
    expect(pane.dispose).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(7));
  });

  it("disposes each generation it owns across a target replacement", async () => {
    const pane = client("pane-1", 9);
    vi.mocked(pane.restore).mockResolvedValueOnce(10);
    const nextTarget = { ...target, sessionPath: "/next" };
    const view = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.create).toHaveBeenCalledWith(target));
    view.rerender(<AgentPane client={pane} target={nextTarget} generation={10} />);
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(9));
    expect(pane.restore).toHaveBeenCalledWith(nextTarget);

    view.unmount();
    await waitFor(() => expect(pane.dispose).toHaveBeenCalledWith(10));
  });

  it("reports failed restore and remains recoverable after a target change", async () => {
    const pane = client("pane-1", 9);
    vi.mocked(pane.restore).mockRejectedValueOnce(new Error("restore failed"));
    const onError = vi.fn();
    const view = render(
      <AgentPane client={pane} target={target} generation={4} onLifecycleError={onError} />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(pane.dispose).not.toHaveBeenCalled();
    const recoverTarget = { ...target, sessionPath: null };
    view.rerender(
      <AgentPane client={pane} target={recoverTarget} generation={4} onLifecycleError={onError} />,
    );
    await waitFor(() => expect(pane.restore).toHaveBeenCalledWith(recoverTarget));
  });

  it.each(["@Supah question", "@Ken question", "@KEN: question", "  @supah:question"])(
    "routes %s to the mentor client",
    async (prompt) => {
      const pane = client("pane-1", 1);
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(pane.selectWorkspace).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: prompt } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(pane.sendKenPrompt).toHaveBeenCalledWith("question", {
          conversationId: "conversation",
          activationEpoch: "epoch",
        }),
      );
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      // Live bubble shows the canonical handle so it matches the reloaded history row.
      expect(document.querySelector(".user-msg.user-ken")?.textContent).toBe(
        `${MENTOR_HANDLE} question`,
      );
    },
  );

  it("renders a reloaded mentor question exactly like the live question bubble", async () => {
    const pane = client("pane-1", 1);
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "user", text: "@Ken question", ken: true },
    ] as Awaited<ReturnType<PaneAgentClient["listHistory"]>>);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    await waitFor(() =>
      expect(document.querySelector(".user-msg.user-ken")?.textContent).toBe(
        `${MENTOR_HANDLE} question`,
      ),
    );
  });

  it("does not route a handle-prefixed file mention like @kennedy.ts to the mentor", async () => {
    const pane = client("pane-1", 1);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(pane.selectWorkspace).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "@kennedy.ts question" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalled());
    expect(pane.sendKenPrompt).not.toHaveBeenCalled();
  });

  it("keeps reset authority over pending initial hydration and reconnects to the announced run", async () => {
    nativeMocks.realMentor = true;
    const pane = client("pane-ken-hydration", 1);
    const emit = liveEvents(pane);
    const pending = deferred<AgentModule.AgentState>();
    vi.mocked(pane.getState).mockReturnValue(pending.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.getState).toHaveBeenCalled());
    const ken = { conversationId: "new", activationEpoch: "new", runId: "new-run" };
    act(() => emit("session_reset", { kenState: { ...ken, activeRunId: null } }));
    await act(async () =>
      pending.resolve({
        running: false,
        provider: "anthropic",
        model: "test",
        cwd: "/work",
        mode: "code",
        kenState: { conversationId: "old", activationEpoch: "old", activeRunId: "old-run" },
      } as AgentModule.AgentState),
    );
    expect(screen.queryByRole("button", { name: "Cancel Ken's reply" })).toBeNull();
    act(() => {
      emit("ready", { running: false, kenState: { ...ken, activeRunId: ken.runId } });
      emit("ken_text_delta", { ken, text: "reconnected mentor output" });
    });
    // Ken's reply is still streaming, so its words sit in separate fade-in
    // spans: match the mentor row's text rather than a single text node.
    await waitFor(() =>
      expect(document.querySelector(".ken-msg .assistant-text")?.textContent).toBe(
        "reconnected mentor output",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel Ken's reply" }));
    expect(pane.cancelKen).toHaveBeenCalledWith(ken);
  });

  it.each([false, true])(
    "scopes real mentor cancel rejection across a newer run (replacement=%s)",
    async (replace) => {
      nativeMocks.realMentor = true;
      const pane = client("pane-real-ken", 1);
      const emit = liveEvents(pane);
      const identity = {
        conversationId: "conversation",
        activationEpoch: "epoch",
        runId: "old-run",
      };
      vi.mocked(pane.getState).mockResolvedValue({
        running: false,
        provider: "anthropic",
        model: "test",
        cwd: "/work",
        mode: "code",
        kenState: {
          conversationId: identity.conversationId,
          activationEpoch: identity.activationEpoch,
          activeRunId: identity.runId,
        },
      } as AgentModule.AgentState);
      const pending = deferred<void>();
      vi.mocked(pane.cancelKen).mockReturnValue(pending.promise);
      render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
      const cancel = await screen.findByRole("button", { name: "Cancel Ken's reply" });
      fireEvent.click(cancel);
      expect(pane.cancelKen).toHaveBeenCalledWith(identity);
      act(() =>
        emit("extras", {
          kenState: { ...identity, activeRunId: replace ? "new-run" : identity.runId },
        }),
      );
      await act(async () => {
        pending.reject(new Error("cancel rejected for captured run"));
      });
      expect(screen.queryByText(/cancel rejected for captured run/) !== null).toBe(!replace);
      expect(screen.getByRole("button", { name: "Cancel Ken's reply" })).toBeTruthy();
      if (replace) {
        act(() => emit("ken_run_end", { ken: identity }));
        expect(screen.getByRole("button", { name: "Cancel Ken's reply" })).toBeTruthy();
      }
    },
  );
});
