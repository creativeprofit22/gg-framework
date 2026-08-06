// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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

vi.mock("./provider-logos", () => ({ providerLogo: () => null }));

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
});
