// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AuthProvider, SidecarEvent } from "./agent";
import { authStatus } from "./agent";
import { LoginScreen } from "./LoginScreen";

const listeners = vi.hoisted(() => new Set<(e: SidecarEvent) => void>());

vi.mock("./agent", () => ({
  authStatus: vi.fn(),
  subscribe: (fn: (e: SidecarEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

vi.mock("./provider-logos", () => ({
  providerLogo: () => null,
  isMonochromeProviderLogo: () => false,
}));

// Observe the hub's modal metadata and callback without invoking native auth.
vi.mock("./ProviderLoginModal", () => ({
  ProviderLoginModal: ({
    provider,
    onChanged,
  }: {
    provider: AuthProvider;
    onChanged: () => void;
  }) => (
    <div role="dialog">
      <output data-testid="active-provider">{JSON.stringify(provider)}</output>
      <button onClick={onChanged}>Refresh after change</button>
    </div>
  ),
}));

function deferredStatus() {
  let resolve!: (value: AuthProvider[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<AuthProvider[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function qwenProviders(connected: boolean): AuthProvider[] {
  return [
    ...providers(["anthropic"]),
    {
      value: "qwen-cloud",
      label: "Qwen Cloud (Token Plan)",
      description: "Token Plan",
      methods: ["apikey"],
      connected,
      connectedMethods: connected ? ["apikey"] : [],
      nativeManaged: true,
    },
  ];
}

function expectQwen(connected: boolean) {
  const tile = screen.getByRole("button", { name: /Qwen Cloud/ });
  expect(within(tile).queryByLabelText("Connected") !== null).toBe(connected);
  expect(screen.getByText(`${connected ? 2 : 1} connected`)).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /Anthropic/ })).getByLabelText("Connected"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /xAI/ })).queryByLabelText("Connected"),
  ).toBeNull();
}

function expectActive(connected: boolean) {
  expect(JSON.parse(screen.getByTestId("active-provider").textContent!)).toEqual(
    qwenProviders(connected)[2],
  );
}

function providers(connected: string[]): AuthProvider[] {
  return [
    { value: "anthropic", label: "Anthropic", description: "", methods: ["oauth"] },
    { value: "xai", label: "xAI (Grok)", description: "", methods: ["apikey"] },
  ].map((p) => ({ ...p, connected: connected.includes(p.value) })) as AuthProvider[];
}

/** Deliver one frame the way the sidecar/Rust fan-out would. */
async function emit(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    for (const fn of listeners) fn({ type, data } as SidecarEvent);
    await Promise.resolve();
  });
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(authStatus).mockReset();
});
afterEach(cleanup);

describe("LoginScreen cross-window auth", () => {
  it.each([false, true])(
    "ignores an older initial reply after Qwen connected=%s",
    async (connected) => {
      const initial = deferredStatus();
      const newer = deferredStatus();
      vi.mocked(authStatus).mockReturnValueOnce(initial.promise).mockReturnValueOnce(newer.promise);
      render(<LoginScreen onClose={vi.fn()} />);
      await emit("auth_change", { provider: "qwen-cloud" });
      await act(async () => newer.resolve(qwenProviders(connected)));
      expectQwen(connected);
      fireEvent.click(screen.getByRole("button", { name: /Qwen Cloud/ }));
      expectActive(connected);
      await act(async () => initial.resolve(qwenProviders(!connected)));
      expectQwen(connected);
      expectActive(connected);
    },
  );

  it.each(["event/event", "event/callback", "callback/event"])(
    "shares latest-request ordering across %s refreshes and modal metadata",
    async (order) => {
      vi.mocked(authStatus).mockResolvedValue(qwenProviders(false));
      await act(async () => {
        render(<LoginScreen onClose={vi.fn()} />);
      });
      fireEvent.click(screen.getByRole("button", { name: /Qwen Cloud/ }));
      const older = deferredStatus();
      const newer = deferredStatus();
      vi.mocked(authStatus).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      for (const source of order.split("/")) {
        if (source === "event") await emit("auth_change", { provider: "qwen-cloud" });
        else fireEvent.click(screen.getByRole("button", { name: "Refresh after change" }));
      }
      await act(async () => newer.resolve(qwenProviders(true)));
      expectQwen(true);
      expectActive(true);
      await act(async () => older.resolve(qwenProviders(false)));
      expectQwen(true);
      expectActive(true);
      expect(authStatus).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps loading when an obsolete initial read %ss",
    async (settle) => {
      const initial = deferredStatus();
      const newer = deferredStatus();
      vi.mocked(authStatus).mockReturnValueOnce(initial.promise).mockReturnValueOnce(newer.promise);
      render(<LoginScreen onClose={vi.fn()} />);
      await emit("auth_change", { provider: "qwen-cloud" });
      await act(async () => {
        if (settle === "resolve") initial.resolve(qwenProviders(true));
        else initial.reject(new Error("Synthetic status failure"));
      });
      expect(screen.getByText("checking providers…")).toBeTruthy();
      expect(screen.queryByText(/\d connected/)).toBeNull();
      await act(async () => newer.resolve(qwenProviders(false)));
      expectQwen(false);
    },
  );

  it("ends loading when the latest read fails and ignores older success", async () => {
    const initial = deferredStatus();
    const newer = deferredStatus();
    vi.mocked(authStatus).mockReturnValueOnce(initial.promise).mockReturnValueOnce(newer.promise);
    render(<LoginScreen onClose={vi.fn()} />);
    await emit("auth_change", { provider: "qwen-cloud" });
    await act(async () => newer.reject(new Error("Synthetic status failure")));
    expect(screen.queryByText("checking providers…")).toBeNull();
    expect(screen.getByText("0 connected")).toBeTruthy();
    await act(async () => initial.resolve(qwenProviders(true)));
    expect(screen.queryByRole("button", { name: /Qwen Cloud/ })).toBeNull();
  });

  it("invalidates reads on effect cleanup and unmount", async () => {
    const obsolete = deferredStatus();
    const current = deferredStatus();
    const pending = deferredStatus();
    vi.mocked(authStatus)
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(pending.promise);
    const view = render(
      <StrictMode>
        <LoginScreen onClose={vi.fn()} />
      </StrictMode>,
    );
    expect(listeners.size).toBe(1);
    await act(async () => current.resolve(qwenProviders(false)));
    await act(async () => obsolete.resolve(qwenProviders(true)));
    expectQwen(false);
    await emit("auth_change", { provider: "qwen-cloud" });
    view.unmount();
    expect(listeners.size).toBe(0);
    await act(async () => pending.resolve(qwenProviders(true)));
    expect(view.container.textContent).toBe("");
    await emit("auth_change", { provider: "qwen-cloud" });
    expect(authStatus).toHaveBeenCalledTimes(3);
  });

  it("refreshes connection state when another window connects a provider", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText("0 connected")).toBeTruthy();

    // Another window completed a login; auth.json is shared, so this screen is
    // now stale. Without the auth_change subscription it stayed at "0 connected"
    // until the screen was reopened.
    vi.mocked(authStatus).mockResolvedValue(providers(["anthropic"]));
    await emit("auth_change", { provider: "anthropic" });

    expect(screen.getByText("1 connected")).toBeTruthy();
  });

  it("refreshes when another window disconnects a provider", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers(["anthropic"]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText("1 connected")).toBeTruthy();

    // Logout is native (Rust), so the sidecar never sees it — Rust emits
    // auth_change directly. `auth_done` would be the wrong signal here: nothing
    // logged in.
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await emit("auth_change", { provider: "anthropic" });

    expect(screen.getByText("0 connected")).toBeTruthy();
  });

  it("ignores unrelated agent events", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(authStatus).toHaveBeenCalledTimes(1);

    await emit("text_delta", { text: "hi" });
    await emit("run_end", {});

    // A re-read per streamed token would be absurd.
    expect(authStatus).toHaveBeenCalledTimes(1);
  });

  it("shows the Ollama tile by name and the Hugging Face download tile", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    // Not clicking them: the real modals would call agent functions this test's
    // minimal mock doesn't define. The tiles themselves are what need pinning.
    expect(screen.getByText("Ollama")).toBeTruthy();
    expect(screen.queryByText("Local models")).toBeNull();
    expect(screen.getByTitle("Hugging Face — download models to Ollama")).toBeTruthy();
  });
});
