// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  modelListener: undefined as (() => void) | undefined,
  unlisten: vi.fn(),
}));

vi.mock("./agent", () => {
  class AzureConnectionCommandError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly field: "endpoint" | "deployment" | "apiKey" | null = null,
    ) {
      super(message);
    }
  }
  return {
    AzureConnectionCommandError,
    getAzureConnectionStatus: agentMocks.getStatus,
    saveAzureConnection: agentMocks.save,
    removeAzureConnection: agentMocks.remove,
    onModelsChanged: vi.fn(async (listener: () => void) => {
      agentMocks.modelListener = listener;
      return agentMocks.unlisten;
    }),
  };
});

import { AzureConnectionCommandError } from "./agent";
import { AzureConnectionSettings } from "./AzureConnectionSettings";
import type { AzureConnectionStatus } from "./agent";

const disconnected: AzureConnectionStatus = {
  configured: false,
  source: "none",
  endpoint: null,
  deployment: null,
  endpointSummary: null,
  deploymentSummary: null,
  hasStoredKey: false,
};

const connected: AzureConnectionStatus = {
  configured: true,
  source: "secure",
  endpoint: "https://sample.openai.azure.com",
  deployment: "gpt-production",
  endpointSummary: "sample.openai.azure.com",
  deploymentSummary: "gpt-production",
  hasStoredKey: true,
};

const environment: AzureConnectionStatus = {
  configured: true,
  source: "environment",
  endpoint: null,
  deployment: null,
  endpointSummary: "env-resource.openai.azure.com",
  deploymentSummary: "env-deployment",
  hasStoredKey: false,
};

async function renderState(state: AzureConnectionStatus): Promise<ReturnType<typeof render>> {
  agentMocks.getStatus.mockResolvedValue(state);
  const result = render(<AzureConnectionSettings />);
  await screen.findByText(
    state.source === "secure"
      ? "Connected"
      : state.source === "environment"
        ? "Environment"
        : "Not connected",
  );
  return result;
}

function fillConnection(key = "canary-secret-value"): void {
  fireEvent.change(screen.getByLabelText("Endpoint"), {
    target: { value: "https://sample.openai.azure.com" },
  });
  fireEvent.change(screen.getByLabelText("Deployment"), {
    target: { value: "gpt-production" },
  });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
}

beforeEach(() => {
  agentMocks.getStatus.mockReset();
  agentMocks.save.mockReset();
  agentMocks.remove.mockReset();
  agentMocks.unlisten.mockReset();
  agentMocks.modelListener = undefined;
});

afterEach(cleanup);

describe("AzureConnectionSettings", () => {
  it("renders a labeled disconnected form with a write-only password field", async () => {
    const { container } = await renderState(disconnected);

    expect(screen.getByLabelText("Endpoint")).toHaveProperty("type", "url");
    expect(screen.getByLabelText("Deployment")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toHaveProperty("type", "password");
    expect(screen.getByRole("button", { name: "Validate and connect" })).toBeTruthy();
    expect(container.textContent).toContain("never returned");
  });

  it("shows a secret-free connected summary and prefilled edit state", async () => {
    const { container } = await renderState(connected);

    expect(screen.getByText("sample.openai.azure.com")).toBeTruthy();
    expect(screen.getByText("gpt-production")).toBeTruthy();
    expect(screen.getByText(/stored securely/)).toBeTruthy();
    expect(container.innerHTML).not.toContain("canary-secret-value");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Endpoint")).toHaveProperty("value", connected.endpoint);
    expect(screen.getByLabelText("Deployment")).toHaveProperty("value", connected.deployment);
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(screen.getByPlaceholderText("Leave blank to keep stored key")).toBeTruthy();
  });

  it("renders environment fallback as read-only and names its controls", async () => {
    await renderState(environment);

    expect(screen.getByText("env-resource.openai.azure.com")).toBeTruthy();
    expect(screen.getByText("Provided by environment")).toBeTruthy();
    expect(screen.getByText(/AZURE_OPENAI_BASE_URL/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("reports local field errors and focuses the first invalid field", async () => {
    await renderState(disconnected);

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText(/HTTPS Azure resource endpoint/)).toBeTruthy();
    expect(screen.getByText("Enter the Azure deployment name.")).toBeTruthy();
    expect(screen.getByText("Enter an Azure OpenAI API key.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Endpoint")));
    expect(agentMocks.save).not.toHaveBeenCalled();
  });

  it("saves once, clears the key, and completes after the model refresh event", async () => {
    const onConnectionChanged = vi.fn();
    agentMocks.getStatus.mockResolvedValue(disconnected);
    agentMocks.save.mockResolvedValue(connected);
    const { container } = render(
      <AzureConnectionSettings onConnectionChanged={onConnectionChanged} />,
    );
    await screen.findByText("Not connected");
    fillConnection();

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));
    await screen.findByText("Connection saved. Refreshing models.");
    expect(agentMocks.save).toHaveBeenCalledTimes(1);
    expect(agentMocks.save).toHaveBeenCalledWith({
      endpoint: connected.endpoint,
      deployment: connected.deployment,
      apiKey: "canary-secret-value",
    });
    expect(container.innerHTML).not.toContain("canary-secret-value");

    await act(async () => agentMocks.modelListener?.());
    expect(screen.getByText("Azure connection saved. Models refreshed.")).toBeTruthy();
    expect(onConnectionChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  });

  it("clears the key after a sanitized command error and on unmount", async () => {
    agentMocks.save.mockRejectedValue(
      new AzureConnectionCommandError("The API key is invalid.", "invalid_api_key", "apiKey"),
    );
    const result = await renderState(disconnected);
    fillConnection();

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));
    expect(await screen.findByText("The API key is invalid.")).toBeTruthy();
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(document.activeElement).toBe(keyInput);

    fireEvent.change(keyInput, { target: { value: "second-canary-secret" } });
    result.unmount();
    expect(keyInput.value).toBe("");
  });

  it("requires confirmation before removing and handles environment fallback", async () => {
    agentMocks.remove.mockResolvedValue(environment);
    await renderState(connected);

    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(screen.getByRole("alertdialog", { name: "Remove Azure connection?" })).toBeTruthy();
    expect(agentMocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    await screen.findByText("Connection removed. Refreshing models.");
    expect(agentMocks.remove).toHaveBeenCalledTimes(1);
    await act(async () => agentMocks.modelListener?.());
    expect(screen.getByText("Environment")).toBeTruthy();
    expect(screen.getByText("Azure connection removed. Models refreshed.")).toBeTruthy();
  });
});
