// @vitest-environment jsdom
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { imageOriginals } from "../../packages/ggcoder/src/test-support/image-originals";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest";
import type * as AgentModule from "./agent";
import { HOOK_LINES } from "./HookNotice";
import { progressTransition } from "./test-fixtures/progress-transition";
import { playSound } from "./sounds";
import completedVerificationTask from "./test-fixtures/completed-verification-task.json";
import { withRealSidecar } from "../../packages/ggcoder/src/test-support/real-sidecar";
import { queuedPromptMetadataRoundTrip } from "../../packages/ggcoder/src/test-support/queued-prompt-metadata";
import { AgentPane } from "./AgentPane";
import type { PaneAgentClient } from "./agent";
import {
  nativeMocks,
  target,
  agentState,
  deferred,
  paneEvents,
  liveEvents,
  client,
  paneListenerObservers,
  setHydrationCleanupObserver,
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

describe("authoritative progress celebrations", () => {
  afterEach(() => {
    nativeMocks.realProgress = false;
  });

  it.each([
    [55, 56, false, false, false],
    [60, 61, true, false, false],
    [100, 101, true, true, false],
    [55, 151, true, true, false],
    [100, 101, true, true, true],
  ])("resolves %i → %i (rank=%s tier=%s reduced=%s)", async (from, to, rank, tier, reduced) => {
    nativeMocks.realProgress = true;
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: reduced,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const pane = client("rank-events", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("test"));
    const initial = { ...progressTransition(from, from), levelUp: null, eventNonce: null };
    vi.mocked(pane.getProgress).mockResolvedValue(initial);
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.getProgress).toHaveBeenCalled());
    await act(async () => {});
    nativeMocks.toast.mockClear();
    vi.mocked(playSound).mockClear();
    const event = { ...progressTransition(from, to), origin: false };
    act(() => paneEvents(pane)({ type: "progress", data: event }));
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      rank ? `Rank up! → ${event.rankName}` : `Level up! → Level ${to}`,
      "success",
      5200,
    );
    expect(Boolean(container.querySelector(".confetti-canvas"))).toBe(tier && !reduced);
    expect(playSound).not.toHaveBeenCalled();
    expect(container.querySelector(".rank-badge-celebrate")).toBeTruthy();
    act(() => paneEvents(pane)({ type: "progress", data: { ...event, origin: true } }));
    act(() =>
      paneEvents(pane)({
        type: "progress",
        data: { ...event, ladder: [], levelUp: null, eventNonce: null },
      }),
    );
    expect(nativeMocks.toast).toHaveBeenCalledTimes(1);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("uses level-only feedback without legacy ladder data and retains origin audio", async () => {
    nativeMocks.realProgress = true;
    const pane = client("legacy-rank-events", 1);
    vi.mocked(pane.getState).mockResolvedValue(agentState("test"));
    vi.mocked(pane.getProgress).mockResolvedValue({ ...progressTransition(55, 55), levelUp: null });
    const { container } = render(<AgentPane client={pane} target={target} />);
    await act(async () => {});
    nativeMocks.toast.mockClear();
    vi.mocked(playSound).mockClear();
    act(() =>
      paneEvents(pane)({
        type: "progress",
        data: {
          ...progressTransition(55, 101),
          ladder: [],
          origin: true,
        },
      }),
    );
    expect(nativeMocks.toast).toHaveBeenCalledWith("Level up! → Level 101", "success", 5200);
    expect(container.querySelector(".confetti-canvas")).toBeNull();
    expect(playSound).toHaveBeenCalledWith("levelUp");
  });
});

describe("Qwen Cloud thinking labels", () => {
  it.each([
    ["qwen-cloud", "qwen-cloud/qwen3.7-max", "high", "Thinking on", "Thinking off", null],
    ["qwen-cloud", "qwen-cloud/qwen3.7-max", null, "Thinking off", "Thinking on", "high"],
    ["qwen-cloud", "qwen-cloud/glm-5.3", null, "Thinking high", "Thinking max", "max"],
    ["qwen-cloud", "qwen-cloud/glm-5.3", "max", "Thinking max", "Thinking high", "high"],
    // Non-Qwen providers use the Deck's standard level names.
    ["azure", "azure:gpt-test", "high", "Thinking High", "Thinking Max", "max"],
  ] as const)(
    "renders %s %s %s as %s",
    async (provider, model, thinkingLevel, label, next, sent) => {
      const pane = client("thinking-pane", 1);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState(model),
        provider,
        model,
        thinkingLevel,
        supportedThinkingLevels: ["high", "max"],
      });
      vi.mocked(pane.cycleThinking).mockResolvedValue({
        thinkingLevel: "high",
        supportedThinkingLevels: ["high", "max"],
      });
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      // Upstream's Deck thinking radio group supersedes the old cycle button;
      // Qwen Cloud keeps its provider wording there.
      fireEvent.click(await screen.findByRole("button", { name: /^Model / }));
      const group = await screen.findByRole("radiogroup", { name: "Thinking" });
      const current = within(group).getByRole("radio", { name: label });
      expect(current.getAttribute("aria-checked")).toBe("true");
      expect(
        within(group)
          .getAllByRole("radio")
          .filter((radio) => radio.getAttribute("aria-checked") === "true"),
      ).toEqual([current]);
      fireEvent.click(within(group).getByRole("radio", { name: next }));
      await waitFor(() =>
        // Pane-scoped: the thinking change goes to this pane's own session.
        expect(nativeMocks.invoke).toHaveBeenCalledWith("agent_set_thinking", {
          paneId: "thinking-pane",
          level: sent,
        }),
      );
    },
  );
});

describe("pane-local opening (mocked native transport)", () => {
  beforeAll(async () => {
    // Exercise hydration against the real renderer, without cold Markdown imports
    // consuming the first render's act flush. Keep module I/O in fixture setup.
    await import("./Markdown");
  }, 0);

  it.each(["live", "restored"])(
    "renders %s host recommendations in the transcript without run controls (mocked native IPC)",
    async (mode) => {
      nativeMocks.realMentor = true; // Use the real event hook and transcript renderer.
      const pane = client("pane-advisory-section", 1);
      const emit = liveEvents(pane);
      const text =
        "## What AI found: 1 idea, nothing you need to do\n\nInspect configuration manually.\n\nAdvice only: no execution is authorized.";
      if (mode === "restored")
        vi.mocked(pane.listHistory).mockResolvedValue([{ role: "assistant", text }]);
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
      await screen.findByRole("textbox");
      if (mode === "live") {
        act(() => {
          emit("run_start", {});
          emit("tool_call_start", {
            toolCallId: "advice",
            name: "programmatic_advisory_result",
            args: {},
          });
          emit("tool_call_end", { toolCallId: "advice", result: text, isError: false });
          emit("text_delta", { text, standalone: true });
          emit("text_delta", { text: "Generic final sentence." });
          emit("error", { message: "Provider failed after submission" });
          emit("run_end", { outcome: "failed", cancelled: false });
        });
      }
      expect(
        await screen.findAllByRole("heading", {
          name: "What AI found: 1 idea, nothing you need to do",
        }),
      ).toHaveLength(1);
      expect(screen.getByText("Inspect configuration manually.")).toBeTruthy();
      expect(screen.getByText("Advice only: no execution is authorized.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Run(?:\s|$)/i })).toBeNull();
      expect(pane.programmatic).not.toHaveBeenCalled();
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("gates submissions with drafts intact until history and buffered live events are applied", async () => {
    nativeMocks.realMentor = true;
    const pane = client("pane-hydrating", 1);
    const emit = liveEvents(pane);
    const history = deferred<AgentModule.HistoryEntry[]>();
    vi.mocked(pane.listHistory).mockReturnValue(history.promise);
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Draft during connection" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("Draft during connection");
    expect(
      (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/connecting to agent/)).toBeTruthy();
    act(() => {
      emit("text_delta", { text: "Live answer" });
      emit("text_delta", { text: " still streaming" });
      emit("run_end", {});
    });
    await act(async () => history.resolve([{ role: "user", text: "Existing prompt" }]));
    expect(await screen.findByText("Existing prompt")).toBeTruthy();
    expect(await screen.findByText("Live answer still streaming")).toBeTruthy();
    expect(input.value).toBe("Draft during connection");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("Draft during connection")).toHaveLength(1);
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("Draft during connection");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("Existing prompt");
  });

  it.each([
    { clock: "", pausedTimers: false },
    { clock: " with paused application timers", pausedTimers: true },
  ])(
    "discards stale hydration and its events without opening a newer generation's gate$clock",
    async ({ pausedTimers }) => {
      // Hydration uses promises; readiness must not depend on polling application timers.
      if (pausedTimers) {
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
      }
      // [DBG-hydration-7c91] Scalar-only, bounded, synchronous observations: no scheduling.
      const started = performance.now();
      const ledger: Array<Record<string, unknown>> = [];
      let overflow = 0;
      let sequence = 0;
      let active = true;
      let stage = "test-entry";
      let completed = "none";
      let bodyComplete = false;
      let cleanupEnd = false;
      const cleanupSnapshots: Partial<
        Record<"cleanup-start" | "cleanup-end", Record<string, unknown>>
      > = {};
      let requestedGeneration = 1;
      let oldResolution = "not-resolved";
      let newResolution = "not-resolved";
      let mainContainer: HTMLElement | undefined;
      let otherContainer: HTMLElement | undefined;
      const listenerCounts = { main: 0, other: 0 };
      const generations: { main: number | null; other: number | null } = {
        main: null,
        other: null,
      };
      onTestFailed(() => {
        try {
          console.error(
            "[DBG-hydration-7c91]",
            JSON.stringify({
              ledger,
              overflow,
              stage,
              completed,
              bodyComplete,
              cleanupEnd,
              cleanupSnapshots,
              cleanupEndMissing: !cleanupEnd,
            }),
          );
        } finally {
          active = false;
          ledger.length = 0;
        }
      });
      nativeMocks.realMentor = true;
      const pane = client("pane-stale-history", 1);
      const other = client("pane-independent-history", 1);
      const calls = (value: PaneAgentClient) => ({
        restore: vi.mocked(value.restore).mock.calls.length,
        waitForReady: vi.mocked(value.waitForReady).mock.calls.length,
        getState: vi.mocked(value.getState).mock.calls.length,
        listModels: vi.mocked(value.listModels).mock.calls.length,
        listCommands: vi.mocked(value.listCommands).mock.calls.length,
        listTasks: vi.mocked(value.listTasks).mock.calls.length,
        listHistory: vi.mocked(value.listHistory).mock.calls.length,
        sendPrompt: vi.mocked(value.sendPrompt).mock.calls.length,
      });
      const dom = (container: HTMLElement | undefined) => {
        const text = container?.textContent ?? "";
        return {
          connected: container?.isConnected ?? false,
          modelButton: !!container?.querySelector(".dock .model-key"),
          sendDisabled:
            container?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
              ?.disabled ?? null,
          connecting: text.includes("connecting to agent"),
          currentStored: text.includes("Current stored prompt"),
          currentLive: text.includes("Current live answer"),
          staleStored: text.includes("Stale stored prompt"),
          staleLive: text.includes("Stale live answer"),
        };
      };
      const record = (label: string, coarse = false) => {
        if (!active) return;
        const seq = ++sequence;
        if (ledger.length === 64) {
          overflow++;
          return;
        }
        ledger.push({
          seq,
          elapsedMs: performance.now() - started,
          label,
          stage,
          completed,
          bodyComplete,
          requestedGeneration,
          oldResolution,
          newResolution,
          generations: { ...generations },
          listeners: { ...listenerCounts },
          mainCalls: calls(pane),
          otherCalls: calls(other),
          ...(coarse ? { mainDom: dom(mainContainer), otherDom: dom(otherContainer) } : {}),
        });
      };
      const begin = (label: string) => {
        if (!active) return;
        stage = label;
        record(`${label}:start`, true);
      };
      const end = (label: string) => {
        if (!active) return;
        completed = label;
        record(`${label}:complete`, true);
      };
      const mainGeneration = (generation: number) => {
        if (!active) return;
        generations.main = generation;
        record("main-generation");
      };
      const otherGeneration = (generation: number) => {
        if (!active) return;
        generations.other = generation;
        record("other-generation");
      };
      paneListenerObservers.set(pane, (action, count) => {
        listenerCounts.main = count;
        record(`main-listener-${action}`);
      });
      paneListenerObservers.set(other, (action, count) => {
        listenerCounts.other = count;
        record(`other-listener-${action}`);
      });
      setHydrationCleanupObserver((phase) => {
        if (phase === "release") {
          active = false;
          paneListenerObservers.delete(pane);
          paneListenerObservers.delete(other);
          mainContainer = undefined;
          otherContainer = undefined;
          return;
        }
        if (phase === "cleanup-end") cleanupEnd = true;
        cleanupSnapshots[phase] = {
          stage,
          completed,
          bodyComplete,
          requestedGeneration,
          oldResolution,
          newResolution,
          generations: { ...generations },
          listeners: { ...listenerCounts },
          mainCalls: calls(pane),
          otherCalls: calls(other),
          mainDom: dom(mainContainer),
          otherDom: dom(otherContainer),
        };
        record(phase, true);
      });
      record("test-entry");
      const emit = liveEvents(pane);
      const oldHistory = deferred<AgentModule.HistoryEntry[]>();
      const newHistory = deferred<AgentModule.HistoryEntry[]>();
      vi.mocked(pane.listHistory)
        .mockReturnValueOnce(oldHistory.promise)
        .mockReturnValueOnce(newHistory.promise);
      begin("render");
      const view = await act(async () =>
        render(
          <AgentPane
            client={pane}
            target={target}
            generation={1}
            onGenerationChange={mainGeneration}
            workspaceOwnsSessionLifecycle
          />,
        ),
      );
      mainContainer = view.container;
      end("render");
      begin("first-history");
      expect(pane.listHistory).toHaveBeenCalledTimes(1);
      end("first-history");
      begin("stale-event");
      act(() => emit("text_delta", { text: "Stale live answer" }));
      end("stale-event");
      vi.mocked(pane.restore).mockResolvedValue(2);
      vi.mocked(pane.waitForReady).mockResolvedValue({
        ready: true,
        error: null,
        generation: 2,
        sessionId: pane.paneId,
      });
      requestedGeneration = 2;
      begin("rerender");
      await act(async () =>
        view.rerender(
          <AgentPane
            client={pane}
            target={{ ...target, sessionPath: "/new.jsonl" }}
            generation={2}
            onGenerationChange={mainGeneration}
            workspaceOwnsSessionLifecycle
          />,
        ),
      );
      end("rerender");
      begin("second-history");
      expect(pane.listHistory).toHaveBeenCalledTimes(2);
      end("second-history");
      begin("independent-render");
      const otherView = await act(async () =>
        render(
          <AgentPane
            client={other}
            target={target}
            onGenerationChange={otherGeneration}
            workspaceOwnsSessionLifecycle
          />,
        ),
      );
      otherContainer = otherView.container;
      end("independent-render");
      begin("independent-ready");
      // Ready: the dock's connecting status (old footer branch) is gone and the
      // Deck model key is present.
      expect(otherView.container.querySelector(".dock .dock-status")).toBeNull();
      expect(otherView.container.querySelector(".dock .model-key")).not.toBeNull();
      end("independent-ready");
      begin("independent-input");
      const otherInput = within(otherView.container).getByRole("textbox");
      await act(async () => {
        fireEvent.change(otherInput, { target: { value: "Independent prompt" } });
        fireEvent.keyDown(otherInput, { key: "Enter" });
      });
      end("independent-input");
      begin("independent-submit");
      expect(other.sendPrompt).toHaveBeenCalledTimes(1);
      end("independent-submit");
      begin("old-history-act");
      oldResolution = "resolve-invoked";
      record("old-history-resolve-invoked");
      await act(async () => oldHistory.resolve([{ role: "user", text: "Stale stored prompt" }]));
      end("old-history-act");
      begin("gate-assertions");
      const input = within(view.container).getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "New generation draft" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("New generation draft");
      expect(within(view.container).getByText(/connecting to agent/)).toBeTruthy();
      end("gate-assertions");
      begin("current-event");
      act(() => emit("text_delta", { text: "Current live answer" }));
      end("current-event");
      begin("new-history-act");
      newResolution = "resolve-invoked";
      record("new-history-resolve-invoked");
      await act(async () => newHistory.resolve([{ role: "user", text: "Current stored prompt" }]));
      end("new-history-act");
      begin("current-transcript");
      expect(within(view.container).getByText("Current stored prompt")).toBeTruthy();
      end("current-transcript");
      begin("transcript-assertions");
      // Still streaming, so its words sit in separate fade-in spans: match the
      // assistant row's text rather than a single text node.
      expect(
        Array.from(
          view.container.querySelectorAll(".assistant-msg .assistant-text"),
          (node) => node.textContent,
        ).filter((text) => text === "Current live answer"),
      ).toHaveLength(1);
      expect(screen.queryByText("Stale stored prompt")).toBeNull();
      expect(screen.queryByText("Stale live answer")).toBeNull();
      end("transcript-assertions");
      begin("current-input");
      await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
      end("current-input");
      begin("current-submit");
      expect(pane.sendPrompt).toHaveBeenCalledTimes(1);
      end("current-submit");
      if (active) bodyComplete = true;
      end("test-body");
    },
    0,
  ); // No deadline: both clock variants must finish their full assertion sequence.

  it.each(["1536x1024", "1254x1254", "1024x1024"])(
    "restores %s sizing evidence once alongside its image after live rendering",
    async (actual) => {
      nativeMocks.realMentor = true;
      const pane = client(`image-${actual}`, 1);
      const emit = liveEvents(pane);
      const warning =
        actual === "1024x1024"
          ? ""
          : `WARNING: Image saved, requested dimensions not met. Requested: 1024x1024; actual: ${actual}. Original bytes preserved; no resizing applied to the saved image. Exact-size verification failed. (/saved/original.png)`;
      const view = render(
        <AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />,
      );
      await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
      await act(async () => {
        emit("tool_call_start", { toolCallId: "image", name: "generate_image", args: {} });
        emit("tool_call_end", {
          toolCallId: "image",
          result: `Generated image → /saved/original.png\n${warning}`,
          details: {
            imagePreviews: [
              { base64: "AA==", mediaType: "image/png", path: "/saved/original.png" },
            ],
          },
        });
      });
      expect(view.container.querySelectorAll(".img-card")).toHaveLength(1);
      expect(view.container.querySelectorAll(".line.info")).toHaveLength(warning ? 1 : 0);
      if (warning) expect(screen.getAllByText(warning)).toHaveLength(1);
      view.unmount();
      vi.mocked(pane.listHistory).mockResolvedValue([
        {
          role: "assistant",
          text: warning,
          toolImages: [{ src: "data:image/png;base64,AA==", path: "/saved/original.png" }],
        },
      ]);
      for (let reopen = 0; reopen < 2; reopen++) {
        const restored = render(
          <AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />,
        );
        await waitFor(() =>
          expect(restored.container.querySelectorAll(".img-card")).toHaveLength(1),
        );
        expect(restored.container.querySelectorAll(".line.info")).toHaveLength(warning ? 1 : 0);
        if (warning) expect(screen.getAllByText(warning)).toHaveLength(1);
        else expect(screen.queryByText(/Exact-size verification failed/)).toBeNull();
        expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AA==");
        restored.unmount();
      }
    },
  );

  it("reloads older restored screenshots from disk instead of keeping their data", async () => {
    const pane = client("pane-restored-shots", 1);
    vi.mocked(pane.listHistory).mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => ({
        role: "assistant" as const,
        text: "",
        toolImages: [{ src: `data:image/png;base64,SENT${i + 1}`, path: `/shots/${i + 1}.png` }],
      })),
    );
    nativeMocks.invoke.mockImplementation(async (command: string) =>
      command === "read_chat_image" ? { mediaType: "image/png", data: "FROMDISK" } : undefined,
    );
    const view = render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(view.container.querySelectorAll(".img-card")).toHaveLength(13));
    const oldest = await screen.findByRole("img", { name: "/shots/1.png" });
    await waitFor(() => expect(oldest.getAttribute("src")).toBe("data:image/png;base64,FROMDISK"));
    expect(nativeMocks.invoke).toHaveBeenCalledWith("read_chat_image", {
      paneId: pane.paneId,
      path: "/shots/1.png",
    });
    expect(
      nativeMocks.invoke.mock.calls.filter(([command]) => command === "read_chat_image"),
    ).toHaveLength(1);
    expect(screen.getByRole("img", { name: "/shots/13.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,SENT13",
    );
    view.unmount();
  });

  it("opens each exact original from real reopened multi-image history (mocked native open)", async () => {
    await withRealSidecar(async ({ project, manager, open, request }) => {
      const { result, images, hashes } = await imageOriginals(project);
      expect(hashes[0]).not.toBe(hashes[1]);
      const saved = await manager.create(project, "openai", "gpt-5", {
        openAICodexContextProfile: "stable",
      });
      await manager.appendRequiredMessage(saved.path, {
        type: "message",
        id: randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "tool", content: [result] },
      });
      for (let reopen = 0; reopen < 2; reopen++) {
        const sessionId = await open(saved.path);
        const response = await request("/history", sessionId);
        expect(response.ok).toBe(true);
        const { history } = (await response.json()) as { history: AgentModule.HistoryEntry[] };
        expect(history.flatMap((row) => row.toolImages ?? [])).toEqual(
          images.map((image) => ({
            src: `data:${image.mediaType};base64,${image.data}`,
            path: image.path,
          })),
        );
        const pane = client(`originals-${reopen}`, 1);
        vi.mocked(pane.listHistory).mockResolvedValue(history);
        const view = render(
          <AgentPane
            client={pane}
            target={{ ...target, cwd: project }}
            workspaceOwnsSessionLifecycle
          />,
        );
        await waitFor(() => expect(view.container.querySelectorAll(".img-card")).toHaveLength(2));
        for (const [index, image] of images.entries()) {
          nativeMocks.invoke.mockClear();
          fireEvent.click(within(view.container).getByTitle(`Open ${image.path}`));
          await waitFor(() =>
            expect(nativeMocks.invoke).toHaveBeenCalledWith("open_project_path", {
              paneId: pane.paneId,
              path: image.path,
            }),
          );
          expect(
            createHash("sha256")
              .update(await fs.readFile(image.path))
              .digest("hex"),
          ).toBe(hashes[index]);
        }
        view.unmount();
      }
    });
  }, 60_000);

  it("restores prompt text, the last reference chips, and recall when the prompt starts with an example block", async () => {
    const pane = client("pane-reference-restore", 1);
    const text = "Referenced files:\n- earlier.ts\n\nPlease inspect this example.";
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "user", text: `${text}\n\nReferenced files:\n- src/current.ts` },
    ]);
    const view = render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    const prompt = await screen.findByText(text, { exact: true, normalizer: (value) => value });
    expect(prompt.textContent).toBe(`${text}src/current.ts`);
    const chips = view.container.querySelectorAll(".user-file-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("title")).toBe("src/current.ts");
    expect(chips[0].textContent).toBe("src/current.ts");
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe(text);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps submission unavailable when history restoration fails", async () => {
    const pane = client("pane-history-failure", 1);
    vi.mocked(pane.listHistory).mockRejectedValue(new Error("History unavailable"));
    render(<AgentPane client={pane} target={target} workspaceOwnsSessionLifecycle />);
    await waitFor(() => expect(pane.listHistory).toHaveBeenCalled());
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this draft");
    expect(
      (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("keeps transcript, lazy plan links, and image cards tied to their source pane", async () => {
    const panes = [client("primary", 1), client("pane-secondary", 1)];
    const roots = ["/projects/one", "/projects/two"];
    const emitters = panes.map(liveEvents);
    panes.forEach((pane, index) => {
      vi.mocked(pane.getState).mockResolvedValue({ ...agentState("test"), cwd: roots[index] });
      vi.mocked(pane.listHistory).mockResolvedValue([
        { role: "assistant", text: "[Transcript file](same.md)" },
        {
          role: "assistant",
          text: "",
          toolImages: [{ src: "data:image/png;base64,AA==", path: "same.md" }],
        },
      ]);
    });
    const view = render(
      <>
        {panes.map((pane, index) => (
          <AgentPane
            key={pane.paneId}
            client={pane}
            focused={index === 0}
            target={{ ...target, cwd: roots[index] }}
            workspaceOwnsSessionLifecycle
          />
        ))}
      </>,
    );
    // Flush the real lazy parser load inside React's async boundary.
    await act(async () => {
      await import("./Markdown");
    });
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Transcript file" })).toHaveLength(2),
    );
    await waitFor(() => expect(view.container.querySelectorAll(".img-card")).toHaveLength(2));
    act(() =>
      emitters.forEach((emit) =>
        emit("plan_exit", {
          checkpointId: "plan",
          generation: 1,
          planPath: "plan.md",
          content: "[Plan file](same.md)",
        }),
      ),
    );
    for (const reviews of screen.getAllByRole("region", { name: "Pending reviews" })) {
      fireEvent.click(within(reviews).getByRole("button", { name: /^Plan approval required/ }));
    }
    await screen.findAllByRole("link", { name: "Plan file" });
    const slots = view.container.querySelectorAll<HTMLElement>(".agent-pane");
    // Click the unfocused pane first; focus must never choose the destination.
    for (const index of [1, 0]) {
      const slot = slots[index];
      for (const name of ["Transcript file", "Plan file"]) {
        nativeMocks.invoke.mockClear();
        fireEvent.click(within(slot).getByRole("link", { name }));
        await waitFor(() =>
          expect(nativeMocks.invoke).toHaveBeenCalledWith("open_project_path", {
            paneId: panes[index].paneId,
            path: "same.md",
          }),
        );
      }
      nativeMocks.invoke.mockClear();
      fireEvent.click(within(slot).getByTitle("Open same.md"));
      await waitFor(() =>
        expect(nativeMocks.invoke).toHaveBeenCalledWith("open_project_path", {
          paneId: panes[index].paneId,
          path: "same.md",
        }),
      );
    }
  });
});

describe("completed verification task (mocked native transport)", () => {
  it.each(["agent_done", "run_end"])(
    "renders the held final answer after %s and after reloading saved history",
    async (completion) => {
      nativeMocks.realMentor = true;
      const pane = client("completed-verification-task", 1);
      const emit = liveEvents(pane);
      vi.mocked(pane.getState).mockResolvedValue(agentState("azure:gpt-test"));
      const history = completedVerificationTask.history as AgentModule.HistoryEntry[];
      vi.mocked(pane.listHistory).mockResolvedValue(history.slice(0, 2));
      const view = render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      await screen.findByText("Preserve existing changes and update only the sample window.");

      await act(async () => {
        for (const event of completedVerificationTask.events) {
          if (event.type !== "agent_done" && event.type !== "run_end") emit(event.type, event.data);
        }
      });
      expect(screen.queryByText(completedVerificationTask.finalAnswer)).toBeNull();
      await act(async () => {
        emit(completion, { outcome: "completed", cancelled: false });
      });
      expect(
        screen.getByText(completedVerificationTask.finalAnswer).closest(".assistant-msg"),
      ).not.toBeNull();
      await act(async () => {
        emit("run_end", { outcome: "completed", cancelled: false });
      });
      expect(screen.getAllByText(completedVerificationTask.finalAnswer)).toHaveLength(1);
      expect(screen.queryByText("Initial implementation draft.")).toBeNull();
      expect(screen.queryByText("Verification completed draft.")).toBeNull();
      // Both verification hooks announce themselves as critter notices: the
      // recheck first, then the plain verification run.
      const hookNotices = Array.from(
        document.querySelectorAll(".subagents-compact .subagents-compact-text"),
        (node) => node.textContent ?? "",
      );
      expect(hookNotices).toHaveLength(2);
      expect(HOOK_LINES.recheck).toContain(hookNotices[0]);
      expect(HOOK_LINES.verification).toContain(hookNotices[1]);

      view.unmount();
      vi.mocked(pane.listHistory).mockResolvedValue(history);
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      expect(
        (await screen.findByText(completedVerificationTask.finalAnswer)).closest(".assistant-msg"),
      ).not.toBeNull();
      expect(screen.getByText("Update sample window")).toBeTruthy();
    },
  );
});

describe("gg-safe security surfaces (mocked native transport)", () => {
  it("restores collapsed security rows, renders live blocks, and toasts blocked skills once", async () => {
    // Real useAgentEvents handler, so the live security_block event is exercised.
    nativeMocks.realMentor = true;
    localStorage.clear();
    const pane = client("gg-safe-security", 1);
    const emit = liveEvents(pane);
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("test"),
      blockedSkills: [
        {
          name: "evil-skill",
          path: "/p/evil",
          scope: "project",
          reason: "reads secrets",
          hash: "h1",
        },
      ],
      installedThreats: [{ key: "lock:debug@4.4.2", message: "debug@4.4.2 is malware" }],
    });
    const security = { rule: "malicious-package", target: "npm install chalk@5.6.1" };
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "assistant", text: "", security },
      { role: "assistant", text: "", security },
    ] as AgentModule.HistoryEntry[]);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    const restored = await screen.findAllByText(/Blocked for safety: known malware/);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.textContent).toContain("×2");
    expect(nativeMocks.toast).toHaveBeenCalledWith(
      'Skill "evil-skill" blocked for safety: reads secrets',
      "warning",
      8000,
    );
    expect(nativeMocks.toast).toHaveBeenCalledWith("debug@4.4.2 is malware", "warning", 12000);

    await act(async () => {
      emit("security_block", { rule: "dns-exfil", target: "ping x" });
    });
    expect(await screen.findByText(/Blocked for safety: would leak data/)).toBeTruthy();
  });
});

describe("queued cancellation ordering (mocked native transport)", () => {
  it.each([false, true])(
    "ignores a delayed cancellation snapshot after newer events (reset=%s)",
    async (reset) => {
      nativeMocks.realMentor = true;
      const pane = client("queue-cancel", 1);
      const emit = liveEvents(pane);
      const pending = deferred<boolean | null>();
      pane.cancelQueued = vi.fn(() => pending.promise);
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running: true,
        runState: "running",
      });
      render(<AgentPane client={pane} target={target} />);
      await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
      act(() => emit("queued", { count: 1, messages: [{ id: "q1", text: "older" }] }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel queued message" }));
      expect(pane.cancelQueued).toHaveBeenCalledWith("q1");
      act(() => {
        if (reset) emit("session_reset", {});
        emit("queued", { count: 1, messages: [{ id: "q2", text: "newer" }] });
      });
      // Deliberately retain the legacy payload: even this stale response must never own UI state.
      await act(async () => pending.resolve([] as unknown as boolean));
      expect(screen.getByTitle("newer")).toBeTruthy();
      expect(document.querySelector(".queued-bar.leaving")).toBeNull();
      expect(screen.queryByTitle("older")).toBeNull();
    },
  );

  // Regression: a deferred question does not make a typed prompt steer; the
  // sidecar holds it until the run ends, so it must stay visibly queued.
  it("keeps a queued prompt visible and cancellable when only a deferred ask is open", async () => {
    nativeMocks.realMentor = true;
    const pane = client("queue-deferred-ask", 1);
    const emit = liveEvents(pane);
    pane.cancelQueued = vi.fn(async () => true);
    const question = {
      id: "approval",
      kind: "choice",
      question: "Allow this action?",
      options: [{ label: "Allow action", value: "allow" }],
    };
    vi.mocked(pane.sendPrompt).mockResolvedValueOnce({
      queued: true,
      count: 1,
      queueId: "q1",
      steers: false,
    });
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      running: true,
      runState: "running",
    });
    const { container } = render(<AgentPane client={pane} target={target} />);
    await waitFor(() => expect(pane.subscribe).toHaveBeenCalled());
    act(() => {
      emit("ask_user", { id: "ask-1", questions: [question] });
      emit("ask_user_deferred", { id: "ask-1" });
    });
    await screen.findByRole("button", { name: /Allow action/ });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Wait for me" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    act(() => emit("queued", { count: 1, messages: [{ id: "q1", text: "Wait for me" }] }));
    // It waits in the queue strip; the transcript gets it when its own run starts.
    expect(await screen.findByTitle("Wait for me")).toBeTruthy();
    expect(container.querySelector(".user-msg.queued")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    expect(pane.cancelQueued).toHaveBeenCalledWith("q1");
  });
});

describe("slash menu keyboard (mocked native transport)", () => {
  const SLASH_COMMANDS: AgentModule.SlashCommand[] = [
    {
      name: "steroids-plus",
      aliases: [],
      description: "Bigger example search",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "built-in",
    },
    {
      name: "steroids",
      aliases: [],
      description: "Real-repo examples",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "built-in",
    },
    {
      name: "plan",
      aliases: [],
      description: "Plan before building",
      input: { text: "optional", references: "optional", attachments: "optional" },
      source: "built-in",
    },
    {
      name: "add-dir",
      aliases: [],
      description: "Add project folder",
      input: { text: "optional", references: "none", attachments: "none" },
      source: "built-in",
    },
    {
      name: "compact",
      aliases: [],
      description: "Compact the conversation",
      input: { text: "none", references: "optional", attachments: "optional" },
      source: "built-in",
    },
  ];

  async function renderSlashPane(
    paneId: string,
    running = false,
  ): Promise<{ pane: PaneAgentClient; input: HTMLTextAreaElement }> {
    const pane = client(paneId, 8);
    vi.mocked(pane.listCommands).mockResolvedValue(SLASH_COMMANDS);
    if (running) {
      vi.mocked(pane.getState).mockResolvedValue({
        ...agentState("azure:gpt-test"),
        running: true,
        runState: "running",
      });
    }
    render(<AgentPane client={pane} target={target} />);
    const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(pane.listCommands).toHaveBeenCalled());
    return { pane, input };
  }

  async function typeSlash(input: HTMLTextAreaElement, value: string): Promise<void> {
    fireEvent.change(input, { target: { value } });
    await screen.findByRole("listbox", { name: "plays" });
  }

  it("sends an exactly typed command on Enter instead of completing it (2026-11-01 smoke)", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-exact");
    await typeSlash(input, "/steroids");
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(
      within(screen.getAllByRole("option")[0] as HTMLElement).getByText("/steroids"),
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/steroids", [], undefined));
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
  });

  it("completes a wrong-case command on Enter, then sends the canonical name", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-wrong-case");
    await typeSlash(input, "/Steroids");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/steroids ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    expect(vi.mocked(pane.sendPrompt).mock.calls[0]?.[0].trim()).toBe("/steroids");
  });

  it("completes a wrong-case no-text command without a trailing space, then sends it", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-wrong-case-none");
    await typeSlash(input, "/COMPACT");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/compact");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    await screen.findByRole("listbox", { name: "plays" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledWith("/compact", [], undefined));
    expect(pane.sendPrompt).toHaveBeenCalledOnce();
  });

  it("completes a partial match on Enter without sending", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-partial");
    await typeSlash(input, "/ster");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/steroids-plus ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("completes on Tab even when the command is typed exactly", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-tab");
    await typeSlash(input, "/steroids");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/steroids ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("sends a command followed by a trailing space on Enter", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-space");
    fireEvent.change(input, { target: { value: "/steroids " } });
    expect(screen.queryByRole("listbox", { name: "plays" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pane.sendPrompt).toHaveBeenCalledOnce());
    expect(vi.mocked(pane.sendPrompt).mock.calls[0]?.[0].trim()).toBe("/steroids");
  });

  it("closes only the menu on Escape, keeps the draft and does not cancel the run", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-escape", true);
    await typeSlash(input, "/ster");
    expect(input.getAttribute("data-slash-menu-open")).toBe("true");
    const event = createEvent.keyDown(input, { key: "Escape" });
    fireEvent(input, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("listbox", { name: "plays" })).toBeNull();
    expect(input.value).toBe("/ster");
    expect(input.getAttribute("data-slash-menu-open")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(pane.cancel).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/stero" } });
    expect(await screen.findByRole("listbox", { name: "plays" })).toBeTruthy();
    expect(input.getAttribute("data-slash-menu-open")).toBe("true");
  });

  it("moves the highlight with the arrow keys and exposes it to assistive tech", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-arrows");
    await typeSlash(input, "/ster");
    const list = screen.getByRole("listbox", { name: "plays" });
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-haspopup")).toBe("listbox");
    expect(input.getAttribute("aria-expanded")).toBeNull();
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    const options = () => screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/steroids ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("completes the highlighted row when the user arrows off an exact match", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-arrow-off");
    await typeSlash(input, "/steroids");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/steroids-plus ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("completes a mouse-picked row and keeps focus in the composer", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-mouse");
    input.focus();
    await typeSlash(input, "/");
    const row = screen.getByText("/plan").closest("button");
    if (!row) throw new Error("missing /plan row");
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.click(row);
    expect(input.value).toBe("/plan ");
    expect(document.activeElement).toBe(input);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("opens the folder picker for an exactly typed /add-dir on Enter", async () => {
    nativeMocks.openDialog.mockResolvedValueOnce(null);
    const { pane, input } = await renderSlashPane("pane-slash-add-dir");
    await typeSlash(input, "/add-dir");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(nativeMocks.openDialog).toHaveBeenCalledOnce());
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps completing an exactly typed /schedule on Enter", async () => {
    const { pane, input } = await renderSlashPane("pane-slash-schedule");
    await typeSlash(input, "/schedule");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/schedule ");
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });
});

describe("enhancement composer outcomes (mocked native transport)", () => {
  const draft = "Make search wait 300 ms after typing in SearchBox.tsx";
  const enhanced = "Debounce search by 300 ms after typing in SearchBox.tsx";

  async function renderHydratedComposer(pane: PaneAgentClient, running = false): Promise<void> {
    vi.mocked(pane.getState).mockResolvedValue({
      ...agentState("azure:gpt-test"),
      running,
      runState: running ? "running" : "idle",
    });
    // Keep project selection and real history hydration, without making composer
    // tests depend on the unrelated lazy Ken Markdown/action renderer.
    vi.mocked(pane.listHistory).mockResolvedValue([
      { role: "user", text: "Existing search request" },
    ]);
    render(<AgentPane client={pane} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
    expect(await screen.findByText("Existing search request")).toBeTruthy();
    // This footer branch uses readyRef, the same gate as submission, and appears
    // after history replay and setHydrated (which gates enhancement). Do not type
    // a readiness probe: that would start/stop the placeholder timers under test.
    // Finish this real-clock wait before any test starts its animation clock.
    // The Deck port dropped the footer; its readyRef branch is now the dock's
    // connecting status, which unmounts once the pane is ready.
    await waitFor(() => expect(document.querySelector(".dock .dock-status")).toBeNull());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(pane.enhancePrompt).not.toHaveBeenCalled();
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    const enhance = document.querySelector<HTMLButtonElement>(".enhance-pill");
    expect(enhance?.parentElement?.classList.contains("enhance-pill-host")).toBe(true);
    expect(enhance?.parentElement?.classList.contains("visible")).toBe(false);
    expect(enhance?.disabled).toBe(true);
    const send = screen.getByRole("button", { name: running ? "Stop response" : "Send message" });
    expect(send.classList.contains("composer-send-icon")).toBe(true);
    expect(send.classList.contains("icon-circle-primary")).toBe(true);
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prewarms the prompt cache on the first keystroke and after a 4 minute pause", async () => {
    const pane = client("prewarm-idle", 1);
    await renderHydratedComposer(pane);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fireEvent.change(input, { target: { value: "a" } });
    expect(pane.prewarmCache).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 4 * 60_000);
    fireEvent.change(input, { target: { value: "ab" } });
    expect(pane.prewarmCache).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 8 * 60_000 + 1);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(pane.prewarmCache).toHaveBeenCalledTimes(2);
  });

  it("does not prewarm the prompt cache while a run is active", async () => {
    const pane = client("prewarm-running", 1);
    await renderHydratedComposer(pane, true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "follow-up" } });
    expect(pane.prewarmCache).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps successful output editable without sending (reduced=%s)",
    async (reduced) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: reduced && query === "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const pane = client("enhance-success", 1);
      vi.mocked(pane.enhancePrompt).mockResolvedValue({
        enhanced,
        segments: [
          {
            kind: "term",
            text: "Debounce",
            original: "Make search wait",
            note: "Delay until typing pauses",
          },
          { kind: "text", text: " search by 300 ms after typing in SearchBox.tsx" },
        ],
      });
      await renderHydratedComposer(pane, true);
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: draft } });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Enhance?" }));
      // Flush each React phase before advancing the next phase's RAF clock.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(pane.enhancePrompt).toHaveBeenCalledWith(draft);
      expect(input.value).toBe(enhanced);
      expect(document.activeElement).toBe(input);
      expect(input.disabled).toBe(false);
      expect(input.readOnly).toBe(false);
      expect(pane.sendPrompt).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: `${enhanced} and keep it cancellable` } });
      expect(input.value).toBe(`${enhanced} and keep it cancellable`);
    },
  );

  it.each(
    [false, true].flatMap((reduced) =>
      ["x".repeat(12_000), "😀".repeat(6_000)].map((text) => ({ reduced, text })),
    ),
  )("enforces UTF-16 enhancement limits (case %#)", async ({ reduced, text }) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const pane = client("enhance-limit", 1);
    vi.mocked(pane.enhancePrompt).mockReturnValue(new Promise(() => {}));
    await renderHydratedComposer(pane);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    const oversized = `${text}x`;
    expect(text.length).toBe(12_000);
    expect(oversized.length).toBe(12_001);
    fireEvent.change(input, { target: { value: oversized } });
    const unavailable = screen.getByRole("button", { name: "Enhance?" }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    const reason = document.getElementById(unavailable.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toContain("12,000");
    expect(reason?.textContent).toContain("You can still send this draft");
    fireEvent.click(unavailable);
    expect(pane.enhancePrompt).not.toHaveBeenCalled();
    expect(document.querySelector(".enh-diss, .enhance-pill.enhancing, .input-anim")).toBeNull();
    expect(input.value).toBe(oversized);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.hasAttribute("maxlength")).toBe(false);
    fireEvent.change(input, { target: { value: text } });
    const available = screen.getByRole("button", { name: "Enhance?" }) as HTMLButtonElement;
    expect(available.disabled).toBe(false);
    expect(available.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(available);
    expect(pane.enhancePrompt).toHaveBeenCalledExactlyOnceWith(text);
    expect(Boolean(document.querySelector(".enh-diss"))).toBe(!reduced);
    expect(pane.sendPrompt).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves rejected drafts and permits retry (reduced=%s)",
    async (reduced) => {
      vi.stubGlobal("matchMedia", () => ({
        matches: reduced,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const pane = client("enhance-failure", 1);
      vi.mocked(pane.enhancePrompt).mockRejectedValue(new Error("Invalid enhancement response"));
      await renderHydratedComposer(pane);
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: draft } });
      fireEvent.click(screen.getByRole("button", { name: "Enhance?" }));
      await waitFor(() =>
        expect(nativeMocks.toast).toHaveBeenCalledWith("Invalid enhancement response", "error"),
      );
      expect(input.value).toBe(draft);
      expect(input.disabled).toBe(false);
      expect(document.querySelector(".enh-diss")).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Enhance?" }));
      await waitFor(() => expect(pane.enhancePrompt).toHaveBeenCalledTimes(2));
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves exact input and ignores stale enhancement results (reduced=%s)",
    async (reduced) => {
      vi.stubGlobal("matchMedia", () => ({
        matches: reduced,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const pane = client("enhance-stale", 1);
      let resolve!: (result: AgentModule.EnhanceResult) => void;
      vi.mocked(pane.enhancePrompt).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await renderHydratedComposer(pane);
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      const original = `  ${draft}\n`;
      fireEvent.change(input, { target: { value: original } });
      fireEvent.click(screen.getByRole("button", { name: "Enhance?" }));
      await waitFor(() => expect(pane.enhancePrompt).toHaveBeenCalledWith(original));
      fireEvent.change(input, { target: { value: "A newer draft" } });
      await act(async () => {
        resolve({ enhanced, segments: [{ kind: "text", text: enhanced }] });
      });
      expect(input.value).toBe("A newer draft");
      expect(pane.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("renders corrected terms when the user explicitly sends the enhanced draft", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const pane = client("enhance-segments", 1);
    const segments: AgentModule.PromptSegment[] = [
      {
        kind: "term",
        text: "Debounce",
        original: "Make search wait",
        note: "Delay until typing pauses",
      },
      { kind: "text", text: " search by 300 ms after typing in SearchBox.tsx" },
    ];
    vi.mocked(pane.enhancePrompt).mockResolvedValue({ enhanced, segments });
    await renderHydratedComposer(pane);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Enhance?" }));
    await waitFor(() => expect(input.value).toBe(enhanced));
    expect(pane.sendPrompt).not.toHaveBeenCalled();
    // Corrected terms render in the sent bubble, not inside the plain textarea.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(enhanced, [], { enhancements: segments }),
    );
    expect(screen.getByText("Debounce")).toBeTruthy();
  });

  it("keeps corrected terms highlighted after the enhanced draft is edited", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const pane = client("enhance-edited", 1);
    const term: AgentModule.PromptSegment = {
      kind: "term",
      text: "Debounce",
      original: "Make search wait",
      note: "Delay until typing pauses",
    };
    const segments: AgentModule.PromptSegment[] = [
      term,
      { kind: "text", text: " search by 300 ms after typing in SearchBox.tsx" },
    ];
    vi.mocked(pane.enhancePrompt).mockResolvedValue({ enhanced, segments });
    await renderHydratedComposer(pane);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Enhance?" }));
    await waitFor(() => expect(input.value).toBe(enhanced));
    // Edit before the term, then add text after it (with trailing whitespace).
    fireEvent.change(input, { target: { value: `Please ${enhanced}` } });
    fireEvent.change(input, { target: { value: `Please ${enhanced} and keep it cancellable  ` } });
    fireEvent.keyDown(input, { key: "Enter" });
    const sent = `Please ${enhanced} and keep it cancellable`;
    await waitFor(() =>
      expect(pane.sendPrompt).toHaveBeenCalledWith(sent, [], {
        enhancements: [
          { kind: "text", text: "Please " },
          term,
          {
            kind: "text",
            text: " search by 300 ms after typing in SearchBox.tsx and keep it cancellable",
          },
        ],
      }),
    );
    const bubble = document.querySelector(".user-msg .enh-term");
    expect(bubble?.textContent).toBe("Debounce");
    expect(bubble?.getAttribute("title")).toBe(
      "you said: \u201cMake search wait\u201d\nDelay until typing pauses",
    );
  });

  it.each(["steering", "stranded"] as const)(
    "renders exact queued highlights and Ken labels after %s consumption and disk reopen",
    async (mode) => {
      const { history } = await queuedPromptMetadataRoundTrip(mode);
      const pane = client(`queue-metadata-${mode}`, 1);
      vi.mocked(pane.listHistory).mockResolvedValue(history);
      render(<AgentPane client={pane} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
      fireEvent.click(await screen.findByRole("button", { name: "Bind project" }));
      await waitFor(() => expect(document.querySelectorAll(".user-msg")).toHaveLength(3));
      const bubbles = Array.from(document.querySelectorAll(".user-msg"));
      // Steering: Ken's correction lands in the held run, so the user's
      // prompt (which waits for that run) comes last.
      const [userIndex, kenIndex] = mode === "steering" ? [2, 1] : [1, 2];
      const user = bubbles[userIndex];
      const ken = bubbles[kenIndex];
      expect(bubbles[0].classList.contains("user-ken-sent")).toBe(true);
      expect(user?.classList.contains("user-ken-sent")).toBe(false);
      expect(user?.querySelector(".enh-term")?.firstChild?.textContent).toBe("TypeScript");
      expect(user?.querySelector(".enh-term")?.getAttribute("title")).toBe(
        "you said: “type script”\nLanguage name",
      );
      expect(ken?.classList.contains("user-ken-sent")).toBe(true);
      expect(ken?.textContent).toBe(bubbles[0].textContent);
      expect(ken?.textContent).toContain("Sent to");
      expect(screen.queryByText("Cancelled prompt")).toBeNull();
      expect(screen.queryByText("Ken queued prompt")).toBeNull();
      expect(document.querySelector(".queued-pill")).toBeNull();
    },
    60_000,
  );

  it("never offers enhancement for schedule drafts", async () => {
    const pane = client("enhance-schedule", 1);
    await renderHydratedComposer(pane);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/schedule Check search | 15m" },
    });
    expect(screen.queryByRole("button", { name: "Enhance?" })).toBeNull();
    expect(pane.enhancePrompt).not.toHaveBeenCalled();
  });

  it("stops and resumes placeholder timers across blur and typed drafts", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    await renderHydratedComposer(client("placeholder-focus", 1));
    const timer = interval.mock.calls.findIndex(([, delay]) => delay === 12000);
    expect(timer).toBeGreaterThanOrEqual(0);
    const id = interval.mock.results[timer].value;
    fireEvent.blur(window);
    expect(clear).toHaveBeenCalledWith(id);
    interval.mockClear();
    fireEvent.focus(window);
    expect(interval.mock.calls.some(([, delay]) => delay === 12000)).toBe(true);
    interval.mockClear();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
    fireEvent.blur(window);
    fireEvent.focus(window);
    expect(interval.mock.calls.some(([, delay]) => delay === 12000 || delay === 24)).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(interval.mock.calls.some(([, delay]) => delay === 12000)).toBe(true);
  });
});
