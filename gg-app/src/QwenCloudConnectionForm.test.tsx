// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProviderLoginModal } from "./ProviderLoginModal";
import { LoginScreen } from "./LoginScreen";
import { groupByProvider } from "./provider-labels";
import { ModelSelect } from "./ModelSelect";
import { authApiKey, authStatus, type AuthProvider, type SidecarEvent } from "./agent";

const listeners = vi.hoisted(() => new Set<(event: SidecarEvent) => void>());

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./platform", () => ({ supportsNativeSelectPopup: () => true }));
vi.mock("./LocalModelsModal", () => ({ LocalModelsModal: () => null }));
vi.mock("./HfPullModal", () => ({ HfPullModal: () => null }));
vi.mock("./agent", () => ({
  authStatus: vi.fn(async () => [provider]),
  subscribe: (listener: (event: SidecarEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  authApiKey: vi.fn(),
}));
const provider: AuthProvider = {
  value: "qwen-cloud",
  label: "Qwen Cloud (Token Plan)",
  description: "Token Plan",
  methods: ["apikey"],
  connected: false,
  connectedMethods: [],
};
const status = {
  provider: "qwen-cloud",
  credential: "saved",
  verification: "not-tested",
  allowance: "unavailable-with-inference-key",
};
const fakeKey = "sk-sp-fake-ui-only";
beforeEach(() => {
  listeners.clear();
  vi.mocked(authStatus).mockResolvedValue([provider]);
  vi.mocked(invoke).mockReset().mockResolvedValue({ ok: true, status });
});
afterEach(cleanup);

for (const entry of ["modal", "hub"] as const) {
  describe(entry, () => {
    const onChanged = vi.fn();
    async function open(saved = true) {
      onChanged.mockClear();
      vi.mocked(invoke).mockResolvedValueOnce({
        ok: true,
        status: { ...status, credential: saved ? "saved" : "absent" },
      });
      const result =
        entry === "modal"
          ? render(
              <ProviderLoginModal provider={provider} onClose={vi.fn()} onChanged={onChanged} />,
            )
          : render(<LoginScreen onClose={vi.fn()} />);
      if (entry === "hub")
        fireEvent.click(await screen.findByRole("button", { name: /Qwen Cloud/ }));
      await screen.findByText(
        saved ? "Saved connection — not remotely verified" : "No saved connection",
      );
      return result;
    }
    it("uses masked write-only native save and clears on success and unmount", async () => {
      const view = await open();
      const field = screen.getByLabelText("Token Plan API key") as HTMLInputElement;
      expect(field.type).toBe("password");
      expect(field.value).toBe("");
      expect(invoke).toHaveBeenCalledWith("qwen_cloud_connection_status", undefined);
      expect(screen.getByText(/Remaining allowance is unavailable/)).toBeTruthy();
      expect(screen.getByText(/cross-border processing/)).toBeTruthy();
      fireEvent.change(field, { target: { value: fakeKey } });
      fireEvent.click(screen.getByRole("button", { name: "Replace saved key" }));
      await screen.findByText("Key saved locally — not remotely tested.");
      expect(invoke).toHaveBeenCalledWith("qwen_cloud_connection_save", {
        connection: { apiKey: fakeKey },
      });
      expect(field.value).toBe("");
      expect(authApiKey).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: fakeKey } });
      view.unmount();
      expect(field.value).toBe("");
    });
    it("tests only on explicit action with allowance warning, without verifying saved key", async () => {
      await open();
      expect(screen.getByText(/consumes a small amount of plan allowance/)).toBeTruthy();
      expect(
        vi.mocked(invoke).mock.calls.every(([cmd]) => cmd === "qwen_cloud_connection_status"),
      ).toBe(true);
      fireEvent.change(screen.getByLabelText("Token Plan API key"), { target: { value: fakeKey } });
      vi.mocked(invoke).mockResolvedValueOnce({
        ok: true,
        status: { ...status, verification: "succeeded" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
      await screen.findByText(/Entered key test succeeded/);
      expect(screen.getByText("Saved connection — not remotely verified")).toBeTruthy();
      expect((screen.getByLabelText("Token Plan API key") as HTMLInputElement).value).toBe("");
    });
    it("fails closed without IPC and does not expose rejected data", async () => {
      vi.mocked(invoke).mockRejectedValue(new Error(fakeKey));
      if (entry === "modal")
        render(<ProviderLoginModal provider={provider} onClose={vi.fn()} onChanged={vi.fn()} />);
      else {
        render(<LoginScreen onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /Qwen Cloud/ }));
      }
      await screen.findByText(/No browser fallback/);
      expect(document.body.textContent).not.toContain(fakeKey);
      expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    it.each(["save", "remove"] as const)(
      "shows fixed preparation failure copy for %s without echoing secrets",
      async (action) => {
        await open();
        const authReads = vi.mocked(authStatus).mock.calls.length;
        vi.mocked(invoke).mockResolvedValueOnce({
          ok: false,
          code: "preparation-failed",
          message: fakeKey,
        });
        if (action === "save") {
          fireEvent.change(screen.getByLabelText("Token Plan API key"), {
            target: { value: fakeKey },
          });
        }
        fireEvent.click(
          screen.getByRole("button", {
            name: action === "save" ? "Replace saved key" : "Remove connection",
          }),
        );
        expect((await screen.findByRole("alert")).textContent).toBe(
          "The connection was not changed because the app could not prepare the update. Restart the app and retry.",
        );
        expect(document.body.textContent).not.toContain(fakeKey);
        expect(screen.getByText("Saved connection — not remotely verified")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove connection" })).toBeTruthy();
        expect((screen.getByLabelText("Token Plan API key") as HTMLInputElement).value).toBe(
          action === "save" ? fakeKey : "",
        );
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(onChanged).not.toHaveBeenCalled();
        expect(authStatus).toHaveBeenCalledTimes(authReads);
      },
    );
    it.each(["save", "remove"] as const)(
      "refreshes committed %s after reload failure without retrying or reading back the key",
      async (action) => {
        await open(action === "remove");
        vi.mocked(authStatus).mockResolvedValue([
          {
            ...provider,
            connected: action === "save",
            connectedMethods: action === "save" ? ["apikey"] : [],
          },
        ]);
        const authReads = vi.mocked(authStatus).mock.calls.length;
        const field = screen.getByLabelText("Token Plan API key") as HTMLInputElement;
        fireEvent.change(field, { target: { value: fakeKey } });
        vi.mocked(invoke)
          .mockResolvedValueOnce({ ok: false, code: "reload-failed" })
          .mockResolvedValueOnce({
            ok: true,
            status: { ...status, credential: action === "save" ? "saved" : "absent" },
          });
        fireEvent.click(
          screen.getByRole("button", {
            name: action === "save" ? "Save key" : "Remove connection",
          }),
        );
        await screen.findByText(
          action === "save" ? "Saved connection — not remotely verified" : "No saved connection",
        );
        expect(field.value).toBe("");
        expect(screen.queryByRole("button", { name: "Remove connection" }) !== null).toBe(
          action === "save",
        );
        expect(
          screen.getByRole("button", {
            name: action === "save" ? "Replace saved key" : "Save key",
          }),
        ).toBeTruthy();
        if (entry === "modal") expect(onChanged).toHaveBeenCalledTimes(1);
        else {
          await waitFor(() => expect(authStatus).toHaveBeenCalledTimes(authReads + 1));
          await screen.findByText(`${action === "save" ? 1 : 0} connected`);
        }
        expect(screen.getByRole("alert").textContent).toBe(
          "The connection changed, but models could not refresh. Restart the app before using Qwen Cloud.",
        );
        expect(document.body.textContent).not.toContain(fakeKey);
        expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
          "qwen_cloud_connection_status",
          `qwen_cloud_connection_${action}`,
          "qwen_cloud_connection_status",
        ]);
        expect(vi.mocked(invoke).mock.calls[2]).toEqual([
          "qwen_cloud_connection_status",
          undefined,
        ]);
        expect(screen.queryByText("Key saved locally — not remotely tested.")).toBeNull();
        expect(screen.queryByText("Qwen Cloud connection removed.")).toBeNull();
      },
    );
    it.each(["save", "remove"] as const)(
      "retains the committed %s warning when the status refresh also fails",
      async (action) => {
        await open(action === "remove");
        const field = screen.getByLabelText("Token Plan API key") as HTMLInputElement;
        fireEvent.change(field, { target: { value: fakeKey } });
        vi.mocked(invoke)
          .mockResolvedValueOnce({ ok: false, code: "reload-failed" })
          .mockResolvedValueOnce({ ok: false, code: "vault-unavailable" });
        fireEvent.click(
          screen.getByRole("button", {
            name: action === "save" ? "Save key" : "Remove connection",
          }),
        );
        await screen.findByText("Native connection unavailable");
        expect(field.value).toBe("");
        expect(screen.getByRole("alert").textContent).toBe(
          "The connection changed, but models could not refresh. Restart the app before using Qwen Cloud.",
        );
        expect(
          (screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(screen.queryByRole("button", { name: "Remove connection" })).toBeNull();
        expect(document.body.textContent).not.toContain(fakeKey);
        expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
          "qwen_cloud_connection_status",
          `qwen_cloud_connection_${action}`,
          "qwen_cloud_connection_status",
        ]);
        expect(vi.mocked(invoke).mock.calls[2]).toEqual([
          "qwen_cloud_connection_status",
          undefined,
        ]);
        if (entry === "modal") expect(onChanged).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("Key saved locally — not remotely tested.")).toBeNull();
        expect(screen.queryByText("Qwen Cloud connection removed.")).toBeNull();
      },
    );
    it("sanitizes unknown server failures and removes through native IPC", async () => {
      await open();
      vi.mocked(invoke).mockResolvedValueOnce({ ok: false, code: fakeKey });
      fireEvent.change(screen.getByLabelText("Token Plan API key"), { target: { value: fakeKey } });
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
      await screen.findByRole("alert");
      expect(document.body.textContent).not.toContain(fakeKey);
      fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("qwen_cloud_connection_remove", undefined),
      );
    });
  });
}
it("refreshes separately mounted hubs and forms after save and remove in another window", async () => {
  vi.mocked(invoke).mockResolvedValue({ ok: true, status: { ...status, credential: "absent" } });
  const hub = render(<LoginScreen onClose={vi.fn()} />);
  const form = render(
    <ProviderLoginModal provider={provider} onClose={vi.fn()} onChanged={vi.fn()} />,
  );
  await within(hub.container).findByText("0 connected");
  await screen.findByText("No saved connection");
  for (const connected of [true, false]) {
    vi.mocked(authStatus).mockResolvedValue([
      { ...provider, connected, connectedMethods: connected ? ["apikey"] : [] },
    ]);
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      status: { ...status, credential: connected ? "saved" : "absent" },
    });
    act(() => {
      for (const listener of listeners) {
        listener({ type: "auth_change", data: { provider: "qwen-cloud" } });
      }
    });
    await within(hub.container).findByText(`${connected ? 1 : 0} connected`);
    await screen.findByText(
      connected ? "Saved connection — not remotely verified" : "No saved connection",
    );
    expect(within(hub.container).queryByLabelText("Connected") !== null).toBe(connected);
    expect(screen.queryByRole("button", { name: "Remove connection" }) !== null).toBe(connected);
    expect(
      (
        screen.getByRole("button", {
          name: connected ? "Replace saved key" : "Save key",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect((screen.getByLabelText("Token Plan API key") as HTMLInputElement).value).toBe("");
  }
  expect(
    vi.mocked(invoke).mock.calls.every(([cmd]) => cmd === "qwen_cloud_connection_status"),
  ).toBe(true);
  form.unmount();
  hub.unmount();
  expect(listeners.size).toBe(0);
});

it("ignores unrelated auth events and stale status reads", async () => {
  let finishInitial!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishInitial = resolve;
      }),
  );
  const view = render(
    <ProviderLoginModal provider={provider} onClose={vi.fn()} onChanged={vi.fn()} />,
  );
  act(() => {
    for (const data of [null, {}, { provider: "azure" }]) {
      for (const listener of listeners) listener({ type: "auth_change", data });
    }
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  act(() => {
    for (const listener of listeners)
      listener({ type: "auth_change", data: { provider: "qwen-cloud" } });
  });
  await screen.findByText("Saved connection — not remotely verified");
  await act(async () => finishInitial({ ok: true, status: { ...status, credential: "absent" } }));
  expect(screen.getByRole("button", { name: "Remove connection" })).toBeTruthy();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("groups Qwen hosted models separately and keeps namespaced selection", () => {
  const models = [
    { id: "glm-5.3", provider: "glm", name: "GLM 5.3" },
    { id: "qwen-cloud/glm-5.3", provider: "qwen-cloud", name: "GLM 5.3" },
  ];
  expect(groupByProvider(models).map((group) => group.label)).toEqual([
    "Z.AI (GLM)",
    "Qwen Cloud (Token Plan)",
  ]);
  const select = vi.fn();
  render(
    <ModelSelect models={models} currentModel="glm-5.3" onSelect={select} title="Switch model" />,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "qwen-cloud/glm-5.3" } });
  expect(select).toHaveBeenCalledWith("qwen-cloud/glm-5.3");
});
