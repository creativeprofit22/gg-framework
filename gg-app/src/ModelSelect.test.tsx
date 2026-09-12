// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelSelect, loadModelsWithRetry, loadModelsInto } from "./ModelSelect";
import { supportsNativeSelectPopup } from "./platform";
import type { ModelOption } from "./agent";

vi.mock("./platform", () => ({ supportsNativeSelectPopup: vi.fn() }));

const supportsNativeMock = vi.mocked(supportsNativeSelectPopup);

const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
  { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
  {
    id: "local/ollama/gemma4:e2b",
    name: "gemma4:e2b (Ollama)",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: true,
    contextWindow: 131072,
  },
  {
    id: "local/ollama/tiny",
    name: "tiny (Ollama)",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: false,
    contextWindow: 8192,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ModelSelect — native popup", () => {
  it("groups every provider under its own label, local last", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const groups = Array.from(document.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local"]);
  });

  it("disables a tool-less local option and says why in its label", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const option = screen.getByRole("option", { name: /tiny \(Ollama\) — no tool calling/ });
    expect(option.hasAttribute("disabled")).toBe(true);
  });

  it("names the endpoint in the tooltip while a local model is active", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="local/ollama/gemma4:e2b"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    expect(screen.getByLabelText("Switch model").getAttribute("title")).toBe(
      "Switch model — Ollama",
    );
  });
});

describe("loadModelsWithRetry", () => {
  // Platform-independent: the picker is disabled whenever the list is empty, on
  // every OS. Sleep is stubbed out so the backoff does not slow the suite.
  it("retries a failed model load instead of leaving the picker dead all session", async () => {
    // The list loads once per session and an empty list disables the picker, so
    // giving up after one failure stranded the user with no way to switch.
    const fetchModels = vi
      .fn<() => Promise<ModelOption[] | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValue(MODELS);

    const loaded = await loadModelsWithRetry(fetchModels, async () => {});

    expect(loaded).toEqual(MODELS);
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of tries, so boot cannot hang", async () => {
    const fetchModels = vi.fn<() => Promise<ModelOption[] | null>>().mockResolvedValue(null);

    const loaded = await loadModelsWithRetry(fetchModels, async () => {});

    // Still null, but hydrate keeps whatever the picker already had rather
    // than blocking the session opening.
    expect(loaded).toBeNull();
    expect(fetchModels).toHaveBeenCalledTimes(4);
  });
});

describe("loadModelsInto", () => {
  const OTHER_PROJECT_MODELS = [
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ] as unknown as ModelOption[];

  it("drops a stale load that resolves after the project was switched", async () => {
    // The load is fire-and-forget, so the PREVIOUS sidecar's retries can still
    // be running when the user switches project. Applying that late answer
    // would leave the picker listing a project the user already left.
    let generation = 0;
    const startGeneration = ++generation;
    const apply = vi.fn();

    // The stale load answers only after a second hydrate has bumped the
    // generation — exactly the ordering the guard exists for.
    const fetchModels = vi
      .fn<() => Promise<ModelOption[] | null>>()
      .mockImplementation(async () => {
        generation++;
        return MODELS;
      });

    await loadModelsInto(
      fetchModels,
      apply,
      () => generation !== startGeneration,
      async () => {},
    );

    expect(apply).not.toHaveBeenCalled();
  });

  it("applies the newest hydrate's result", async () => {
    const apply = vi.fn();

    await loadModelsInto(
      async () => OTHER_PROJECT_MODELS,
      apply,
      () => false,
      async () => {},
    );

    expect(apply).toHaveBeenCalledWith(OTHER_PROJECT_MODELS);
  });

  it("leaves the picker untouched when every attempt failed", async () => {
    const apply = vi.fn();

    await loadModelsInto(
      async () => null,
      apply,
      () => false,
      async () => {},
    );

    expect(apply).not.toHaveBeenCalled();
  });
});

describe("ModelSelect — in-webview menu", () => {
  function openMenu(current = "claude-sonnet-5", onSelect = vi.fn()) {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={MODELS}
        currentModel={current}
        onSelect={onSelect}
        title="Switch model"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 5|gemma4/ }));
    return onSelect;
  }

  it("says why it is locked instead of going silently inert", () => {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        disabled
        title="Switch model"
      />,
    );

    // Plain footer text gives a disabled control no visual tell, so the reason
    // has to be in the tooltip — not the tooltip's usual "Switch model".
    const trigger = screen.getByRole("button", { name: /Claude Sonnet 5/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("title")).toContain("while the agent is running");
  });

  it("renders one titled section per provider, local last", () => {
    openMenu();

    const headings = Array.from(document.querySelectorAll(".model-menu-subtitle")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local"]);
    // Each section's grid is labelled for screen readers.
    expect(screen.getByRole("group", { name: "Local" })).toBeTruthy();
  });

  it("selects a model from its provider group", () => {
    const onSelect = openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Grok 4.5" }));

    expect(onSelect).toHaveBeenCalledWith("grok-4.5");
  });

  it("refuses to select a tool-less local model", () => {
    const onSelect = openMenu();

    const item = screen.getByRole("menuitemradio", { name: "tiny (Ollama)" });
    expect(item.hasAttribute("disabled")).toBe(true);
    expect(item.getAttribute("title")).toContain("has no tool calling");

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("escapes a clipped narrow footer and stays anchored through desktop resize", () => {
    supportsNativeMock.mockReturnValue(false);
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(484);
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(781);
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 435,
      height: 220,
      top: 0,
      right: 435,
      bottom: 220,
      left: 0,
      toJSON: () => ({}),
    });
    render(
      <div style={{ overflow: "hidden", width: 320, height: 20 }}>
        <ModelSelect
          models={MODELS}
          currentModel="claude-sonnet-5"
          onSelect={vi.fn()}
          title="Switch model"
        />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Claude Sonnet 5" });
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 120,
      y: 720,
      width: 150,
      height: 20,
      top: 720,
      right: 270,
      bottom: 740,
      left: 120,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Switch model" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe("12px");
    expect(menu.style.bottom).toBe("69px");
    expect(menu.style.visibility).toBe("visible");

    width.mockReturnValue(1164);
    height.mockReturnValue(741);
    triggerRect.mockReturnValue({
      x: 781,
      y: 679,
      width: 150,
      height: 20,
      top: 679,
      right: 931,
      bottom: 699,
      left: 781,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));

    expect(menu.style.left).toBe("496px");
    expect(menu.style.bottom).toBe("70px");
  });

  it("preserves menu focus, keyboard selection, Escape, and outside-click dismissal", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const onSelect = openMenu();
    const trigger = screen.getByRole("button", { name: "Claude Sonnet 5" });
    const menu = screen.getByRole("menu", { name: "Switch model" });
    const active = screen.getByRole("menuitemradio", { name: "Claude Sonnet 5" });
    const next = screen.getByRole("menuitemradio", { name: "GPT-5.6 Sol" });

    expect(document.activeElement).toBe(active);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(onSelect).toHaveBeenCalledWith("gpt-5.6-sol");
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Switch model" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("menu", { name: "Switch model" })).toBeTruthy());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Switch model" })).toBeNull();
  });

  it("marks the active model as checked", () => {
    openMenu("local/ollama/gemma4:e2b");

    expect(
      screen
        .getByRole("menuitemradio", { name: "gemma4:e2b (Ollama)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
