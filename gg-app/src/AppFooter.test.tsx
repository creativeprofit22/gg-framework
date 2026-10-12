// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppFooter } from "./AppFooter";
import type { AgentState, ModelOption } from "./agent";
import { supportsNativeSelectPopup } from "./platform";

vi.mock("./platform", () => ({ supportsNativeSelectPopup: vi.fn(() => true) }));
// The footer only needs these from the Tauri bridge.
vi.mock("./agent", () => ({
  cycleThinking: vi.fn(),
  killTask: vi.fn(),
  workspaceProductName: (_mode: string, isGoal = false) => (isGoal ? "GG Goals" : "GG Coder"),
}));

const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
];

function renderFooter(
  state: Partial<AgentState>,
  onSelectCritterModel?: (id: string | null) => void,
): void {
  render(
    <AppFooter
      hydrated
      workspaceMode="code"
      state={{ provider: "anthropic", model: "claude-opus-5-5", ...state } as AgentState}
      tasks={[]}
      schedules={[]}
      stopSchedule={vi.fn()}
      runningTaskCount={0}
      contextUsed={0}
      contextWindow={0}
      running={false}
      kenRunning={false}
      autopilotReviewing={false}
      models={MODELS}
      modelsFailed={false}
      onSelectModel={vi.fn()}
      onSelectKenModel={vi.fn()}
      onSelectCritterModel={onSelectCritterModel}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(supportsNativeSelectPopup).mockReturnValue(true);
});

describe("AppFooter in a Goal window", () => {
  const goal = { id: "seo", name: "SEO", needsKickoff: false, phase: "active" } as const;

  it("swaps Ken for Critters, following GG Goals until a model is pinned", () => {
    const pick = vi.fn();
    renderFooter({ goal: { ...goal, critterModel: null } }, pick);
    expect(screen.queryByText("Ken")).toBeNull();
    expect(screen.getByText("Critters")).toBeDefined();
    const picker = screen.getByTitle("Critters follow GG Goals' model. Click to pin one");
    expect((picker.querySelector("option:checked") as HTMLOptionElement | null)?.textContent).toBe(
      "Follow GG Goals (Claude Opus 5.5)",
    );

    fireEvent.change(picker, { target: { value: "claude-sonnet-5-5" } });
    expect(pick).toHaveBeenLastCalledWith("claude-sonnet-5-5");
  });

  it("shows the pinned model, and offers following GG Goals again", () => {
    const pick = vi.fn();
    renderFooter({ goal: { ...goal, critterModel: "claude-sonnet-5-5" } }, pick);
    const picker = screen.getByTitle("Critters are pinned to their own model. Click to change");
    expect((picker as HTMLSelectElement).value).toBe("claude-sonnet-5-5");
    fireEvent.change(picker, { target: { value: "__follow__" } });
    expect(pick).toHaveBeenLastCalledWith(null);
  });

  it("keeps Ken in an ordinary code window", () => {
    renderFooter({});
    expect(screen.getByText("Ken")).toBeDefined();
    expect(screen.queryByText("Critters")).toBeNull();
  });
});
