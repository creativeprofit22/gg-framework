import { invoke } from "@tauri-apps/api/core";

export type AzureConnectionSource = "secure" | "environment" | "none";
export type AzureConnectionErrorField = "endpoint" | "deployment" | "apiKey";

export interface AzureConnectionStatus {
  configured: boolean;
  source: AzureConnectionSource;
  endpoint: string | null;
  deployment: string | null;
  endpointSummary: string | null;
  deploymentSummary: string | null;
  hasStoredKey: boolean;
}

export interface SaveAzureConnection {
  endpoint: string;
  deployment: string;
  /** Blank preserves the existing operating-system vault entry. */
  apiKey?: string;
}

/** A secret-free, UI-safe Azure command failure. */
export class AzureConnectionCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field: AzureConnectionErrorField | null = null,
  ) {
    super(message);
    this.name = "AzureConnectionCommandError";
  }
}

const AZURE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  active_runs: "Finish or cancel every active run before changing the Azure connection.",
  access_forbidden: "This API key cannot access the Azure deployment.",
  api_key_required: "Enter an Azure OpenAI API key.",
  azure_unavailable: "Azure is unavailable right now. Try again shortly.",
  connection_remove_recovery_failed:
    "Azure removal could not be completed safely. Reconnect Azure before using it.",
  connection_rollback_failed:
    "The previous Azure credential could not be restored. Reconnect Azure before using it.",
  deployment_not_found: "The endpoint or deployment could not be found.",
  invalid_api_key: "The Azure OpenAI API key is invalid.",
  invalid_deployment: "Enter a valid Azure deployment name.",
  invalid_endpoint: "Enter a valid HTTPS Azure resource endpoint.",
  metadata_remove_failed: "The Azure connection could not be removed. It remains active.",
  metadata_save_failed:
    "The Azure connection could not be saved. The previous connection remains active.",
  metadata_unavailable: "The saved Azure connection details could not be read. Try again.",
  models_refresh_failed:
    "The Azure connection changed, but models did not refresh. Restart gg-app to apply it.",
  models_refresh_unavailable: "Models could not refresh. Try again after the agent is ready.",
  secure_storage_remove_failed:
    "The credential vault rejected removal. The Azure connection remains active.",
  secure_storage_save_failed:
    "The API key could not be saved in the operating-system credential vault.",
  secure_storage_unavailable:
    "The Azure connection could not be read. Unlock the operating-system credential vault and try again.",
  throttled: "Azure rate-limited the validation request. Try again shortly.",
  validation_failed: "Azure could not validate this connection. Check the details and try again.",
  validation_network_error:
    "Azure could not be reached. Check the endpoint and network connection.",
  validation_timeout: "Azure validation timed out. Check the endpoint and try again.",
  validation_unavailable: "Azure validation is unavailable. Try again shortly.",
};

const AZURE_ERROR_FIELDS: Readonly<Partial<Record<string, AzureConnectionErrorField>>> = {
  api_key_required: "apiKey",
  invalid_api_key: "apiKey",
  invalid_deployment: "deployment",
  invalid_endpoint: "endpoint",
};

export function asAzureCommandError(error: unknown, fallback: string): AzureConnectionCommandError {
  let payload: unknown = error;
  if (typeof error === "string" && error.trimStart().startsWith("{")) {
    try {
      payload = JSON.parse(error);
    } catch {
      payload = null;
    }
  }
  if (typeof payload === "object" && payload !== null) {
    const candidate = payload as { code?: unknown; field?: unknown };
    const candidateCode = typeof candidate.code === "string" ? candidate.code : "";
    const code = Object.prototype.hasOwnProperty.call(AZURE_ERROR_MESSAGES, candidateCode)
      ? candidateCode
      : "unknown";
    const expectedField = AZURE_ERROR_FIELDS[code] ?? null;
    const field = candidate.field === expectedField ? expectedField : null;
    return new AzureConnectionCommandError(
      code === "unknown" ? fallback : AZURE_ERROR_MESSAGES[code],
      code,
      field,
    );
  }
  return new AzureConnectionCommandError(fallback, "unknown");
}

export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_status");
  } catch (error) {
    throw asAzureCommandError(error, "Azure connection status could not be loaded. Try again.");
  }
}

export async function saveAzureConnection(
  connection: SaveAzureConnection,
): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_save", { connection });
  } catch (error) {
    throw asAzureCommandError(error, "The Azure connection could not be saved. Try again.");
  }
}

export async function removeAzureConnection(): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_remove");
  } catch (error) {
    throw asAzureCommandError(error, "The Azure connection could not be removed. Try again.");
  }
}
