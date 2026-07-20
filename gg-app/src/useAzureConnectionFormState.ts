import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AzureConnectionCommandError,
  getAzureConnectionStatus,
  onModelsChanged,
  removeAzureConnection,
  saveAzureConnection,
  type AzureConnectionErrorField,
  type AzureConnectionStatus,
} from "./agent";

export type AzureFieldErrors = Partial<Record<AzureConnectionErrorField, string>>;
export type AzurePendingState = "loading" | "saving" | "removing" | "refreshing" | null;
type RefreshOperation = "save" | "remove";

function localErrors(
  endpoint: string,
  deployment: string,
  hasStoredKey: boolean,
  apiKeyPresent: boolean,
): AzureFieldErrors {
  const errors: AzureFieldErrors = {};
  const trimmedEndpoint = endpoint.trim();
  try {
    const parsed = new URL(trimmedEndpoint);
    const validPath = parsed.pathname === "/" || parsed.pathname === "";
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.endsWith(".openai.azure.com") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !validPath
    ) {
      errors.endpoint =
        "Enter an HTTPS Azure resource endpoint, such as https://example.openai.azure.com.";
    }
  } catch {
    errors.endpoint =
      "Enter an HTTPS Azure resource endpoint, such as https://example.openai.azure.com.";
  }
  if (!deployment.trim()) errors.deployment = "Enter the Azure deployment name.";
  if (!hasStoredKey && !apiKeyPresent) errors.apiKey = "Enter an Azure OpenAI API key.";
  return errors;
}

export function useAzureConnectionFormState(onConnectionChanged?: () => void) {
  const [status, setStatus] = useState<AzureConnectionStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [deployment, setDeployment] = useState("");
  const [errors, setErrors] = useState<AzureFieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");
  const [pending, setPending] = useState<AzurePendingState>("loading");
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const deploymentRef = useRef<HTMLInputElement>(null);
  const keepConnectionRef = useRef<HTMLButtonElement>(null);
  const refreshVersionRef = useRef(0);
  const waitingForModelsRef = useRef(false);
  const refreshOperationRef = useRef<RefreshOperation>("save");
  const onConnectionChangedRef = useRef(onConnectionChanged);
  const endpointErrorId = useId();
  const deploymentErrorId = useId();
  const apiKeyErrorId = useId();
  const generalErrorId = useId();

  useEffect(() => {
    onConnectionChangedRef.current = onConnectionChanged;
  }, [onConnectionChanged]);

  const clearApiKey = useCallback((): void => {
    if (apiKeyRef.current) apiKeyRef.current.value = "";
  }, []);

  const setApiKeyInput = useCallback((node: HTMLInputElement | null): void => {
    if (!node && apiKeyRef.current) apiKeyRef.current.value = "";
    apiKeyRef.current = node;
  }, []);

  const applyStatus = useCallback((nextStatus: AzureConnectionStatus): void => {
    setStatus(nextStatus);
    setEndpoint(nextStatus.endpoint ?? "");
    setDeployment(nextStatus.deployment ?? "");
    setEditing(nextStatus.source === "none");
  }, []);

  const loadStatus = useCallback(async (): Promise<void> => {
    setPending("loading");
    setGeneralError(null);
    try {
      applyStatus(await getAzureConnectionStatus());
    } catch (error) {
      setGeneralError(
        error instanceof AzureConnectionCommandError
          ? error.message
          : "Azure connection status could not be loaded. Try again.",
      );
    } finally {
      setPending(null);
    }
  }, [applyStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (confirmingRemove) keepConnectionRef.current?.focus();
  }, [confirmingRemove]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onModelsChanged(() => {
      refreshVersionRef.current += 1;
      if (waitingForModelsRef.current) {
        waitingForModelsRef.current = false;
        setPending(null);
        setLiveStatus(
          refreshOperationRef.current === "remove"
            ? "Azure connection removed. Models refreshed."
            : "Azure connection saved. Models refreshed.",
        );
      } else {
        void getAzureConnectionStatus()
          .then(applyStatus)
          .catch(() => {});
      }
      onConnectionChangedRef.current?.();
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (apiKeyRef.current) apiKeyRef.current.value = "";
    };
  }, [applyStatus]);

  function focusFirstError(nextErrors: AzureFieldErrors): void {
    window.setTimeout(() => {
      if (nextErrors.endpoint) endpointRef.current?.focus();
      else if (nextErrors.deployment) deploymentRef.current?.focus();
      else if (nextErrors.apiKey) apiKeyRef.current?.focus();
    });
  }

  function handleCommandError(error: unknown): void {
    clearApiKey();
    const safeError =
      error instanceof AzureConnectionCommandError
        ? error
        : new AzureConnectionCommandError(
            "The Azure connection could not be updated. Try again.",
            "unknown",
          );
    if (safeError.field) {
      const nextErrors = { [safeError.field]: safeError.message };
      setErrors(nextErrors);
      focusFirstError(nextErrors);
    } else {
      setGeneralError(safeError.message);
    }
  }

  async function submit(): Promise<void> {
    if (pending) return;
    const apiKeyInput = apiKeyRef.current;
    const apiKey = apiKeyInput ? apiKeyInput.value : "";
    const nextErrors = localErrors(
      endpoint,
      deployment,
      status?.hasStoredKey ?? false,
      Boolean(apiKey),
    );
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setGeneralError(null);
      clearApiKey();
      focusFirstError(nextErrors);
      return;
    }

    const refreshVersion = refreshVersionRef.current;
    setErrors({});
    setGeneralError(null);
    setLiveStatus("Validating and saving securely.");
    setPending("saving");
    try {
      const nextStatus = await saveAzureConnection({
        endpoint: endpoint.trim(),
        deployment: deployment.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      clearApiKey();
      applyStatus(nextStatus);
      setEditing(false);
      refreshOperationRef.current = "save";
      if (refreshVersionRef.current > refreshVersion) {
        setPending(null);
        setLiveStatus("Azure connection saved. Models refreshed.");
      } else {
        waitingForModelsRef.current = true;
        setPending("refreshing");
        setLiveStatus("Connection saved. Refreshing models.");
      }
    } catch (error) {
      setPending(null);
      setLiveStatus("");
      handleCommandError(error);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (pending) return;
    const refreshVersion = refreshVersionRef.current;
    setGeneralError(null);
    setLiveStatus("Removing the connection securely.");
    setPending("removing");
    try {
      const nextStatus = await removeAzureConnection();
      clearApiKey();
      applyStatus(nextStatus);
      setConfirmingRemove(false);
      refreshOperationRef.current = "remove";
      if (refreshVersionRef.current > refreshVersion) {
        setPending(null);
        setLiveStatus("Azure connection removed. Models refreshed.");
      } else {
        waitingForModelsRef.current = true;
        setPending("refreshing");
        setLiveStatus("Connection removed. Refreshing models.");
      }
    } catch (error) {
      setPending(null);
      setLiveStatus("");
      handleCommandError(error);
    }
  }

  function beginEdit(): void {
    clearApiKey();
    setErrors({});
    setGeneralError(null);
    setLiveStatus("");
    setConfirmingRemove(false);
    setEndpoint(status?.endpoint ?? "");
    setDeployment(status?.deployment ?? "");
    setEditing(true);
  }

  function cancelEdit(): void {
    clearApiKey();
    setErrors({});
    setGeneralError(null);
    setConfirmingRemove(false);
    setEndpoint(status?.endpoint ?? "");
    setDeployment(status?.deployment ?? "");
    setEditing(false);
  }

  const connected = status?.configured === true && status.source === "secure";
  const environmentManaged = status?.configured === true && status.source === "environment";

  return {
    status,
    endpoint,
    setEndpoint,
    deployment,
    setDeployment,
    errors,
    generalError,
    liveStatus,
    pending,
    connected,
    environmentManaged,
    showForm: editing && !environmentManaged,
    disabled: pending !== null,
    confirmingRemove,
    setConfirmingRemove,
    endpointRef,
    deploymentRef,
    keepConnectionRef,
    setApiKeyInput,
    endpointErrorId,
    deploymentErrorId,
    apiKeyErrorId,
    generalErrorId,
    loadStatus,
    submit,
    confirmRemove,
    beginEdit,
    cancelEdit,
  };
}
