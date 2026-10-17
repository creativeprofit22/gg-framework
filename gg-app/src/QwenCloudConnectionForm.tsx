import { useCallback, useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  QWEN_CLOUD_TOKEN_PLAN_ENDPOINT,
  type QwenCloudConnectionStatus,
} from "@kenkaiiii/gg-core/qwen-cloud-token-plan";
import { qwenCloudConnection, qwenConnectionError } from "./qwen-cloud-connection";
import { theme } from "./theme";
import { subscribe } from "./agent";

export function QwenCloudConnectionForm({
  onChanged,
}: {
  onChanged: () => void;
}): React.ReactElement {
  const [status, setStatus] = useState<QwenCloudConnectionStatus | null>(null);
  const [pending, setPending] = useState<string | null>("status");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const statusRequest = useRef(0);
  const id = useId();
  const setInput = useCallback((node: HTMLInputElement | null) => {
    if (input.current && input.current !== node) input.current.value = "";
    input.current = node;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const refresh = (): void => {
      const request = ++statusRequest.current;
      void qwenCloudConnection("status").then((result) => {
        if (!mounted.current || request !== statusRequest.current) return;
        if (result.ok) setStatus(result.status);
        else setError(qwenConnectionError(result.code));
        if (!locked.current) setPending(null);
      });
    };
    const unsubscribe = subscribe((event) => {
      if (
        event.type !== "auth_change" ||
        typeof event.data !== "object" ||
        event.data === null ||
        !("provider" in event.data) ||
        event.data.provider !== "qwen-cloud"
      )
        return;
      setNotice(null);
      refresh();
    });
    refresh();
    return () => {
      unsubscribe();
      statusRequest.current += 1;
      mounted.current = false;
      if (input.current) input.current.value = "";
    };
  }, []);

  async function act(action: "save" | "test" | "remove"): Promise<void> {
    if (pending || locked.current) return;
    const key = input.current?.value ?? "";
    if (action !== "remove" && !/^sk-sp-[A-Za-z0-9_-]{1,250}$/.test(key)) {
      setError(qwenConnectionError("invalid-key-format"));
      return;
    }
    locked.current = true;
    statusRequest.current += 1;
    setPending(action);
    setError(null);
    setNotice(null);
    const result = await qwenCloudConnection(action, action === "remove" ? undefined : key);
    if (!result.ok && result.code === "reload-failed" && action !== "test") {
      // Only reload-failed guarantees the vault mutation committed. Refresh metadata,
      // not inference, and retain the warning even if the status read also fails.
      if (input.current) input.current.value = "";
      if (mounted.current) setError(qwenConnectionError(result.code));
      const request = ++statusRequest.current;
      const refreshed = await qwenCloudConnection("status");
      locked.current = false;
      if (!mounted.current) return;
      if (request === statusRequest.current) setStatus(refreshed.ok ? refreshed.status : null);
      setPending(null);
      onChanged();
      return;
    }
    locked.current = false;
    if (!mounted.current) return;
    setPending(null);
    if (!result.ok) {
      setError(qwenConnectionError(result.code));
      return;
    }
    if (input.current) input.current.value = "";
    // Explicit testing verifies only the entered key, never the saved credential.
    if (action === "test")
      setNotice(
        "Entered key test succeeded. This does not save the key or verify the saved connection.",
      );
    else {
      setStatus(result.status);
      setNotice(
        action === "save"
          ? "Key saved locally — not remotely tested."
          : "Qwen Cloud connection removed.",
      );
      onChanged();
    }
  }
  const unavailable = !status || status.credential === "unavailable";
  const disabled = Boolean(pending) || unavailable;
  return (
    <form
      className="azure-settings-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void act("save");
      }}
    >
      <p className="modal-hint">
        Token Plan only. Use an sk-sp- key, not a pay-as-you-go DashScope key.
      </p>
      <button
        className="modal-btn"
        type="button"
        onClick={() =>
          void openUrl(
            "https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart",
          ).catch(() => {})
        }
      >
        Create a Token Plan key
      </button>
      <p className="modal-hint" style={{ overflowWrap: "anywhere" }}>
        Fixed endpoint (not editable): {QWEN_CLOUD_TOKEN_PLAN_ENDPOINT}. No alternate endpoint or
        provider fallback.
      </p>
      <p className="modal-hint">
        Selected prompts, code/context and tool results are sent to Qwen Cloud. Token Plan
        documentation describes Singapore/Global deployment and cross-border processing.
      </p>
      <p className="modal-hint">
        Token Plan · 7-day Credits allowance. Remaining allowance is unavailable with this
        connection.
      </p>
      <button
        className="modal-btn"
        type="button"
        onClick={() => void openUrl("https://console.qwencloud.com/").catch(() => {})}
      >
        Open Qwen console
      </button>
      <p role="status">
        {pending === "status"
          ? "Loading connection…"
          : status?.credential === "saved"
            ? "Saved connection — not remotely verified"
            : unavailable
              ? "Native connection unavailable"
              : "No saved connection"}
      </p>
      <label className="azure-field-label" htmlFor={id}>
        Token Plan API key
      </label>
      <input
        ref={setInput}
        id={id}
        className="modal-input"
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        placeholder="Enter sk-sp- key"
        aria-describedby={`${id}-hint`}
        style={{ color: theme.text, background: theme.inputBackground }}
        onChange={() => setNotice(null)}
      />
      <p id={`${id}-hint`} className="modal-hint azure-key-hint">
        Write-only. Saved keys are never returned or prefilled. Test connection uses the entered key
        and consumes a small amount of plan allowance. Only a fixed short prompt is sent, not
        project context or tools. No background tests.
      </p>
      {error && (
        <p className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="azure-settings-actions">
        <button className="modal-btn primary" type="submit" disabled={disabled}>
          {pending === "save"
            ? "Saving…"
            : status?.credential === "saved"
              ? "Replace saved key"
              : "Save key"}
        </button>
        <button
          className="modal-btn"
          type="button"
          disabled={disabled}
          onClick={() => void act("test")}
        >
          {pending === "test" ? "Testing…" : "Test connection"}
        </button>
        {status?.credential === "saved" && (
          <button
            className="modal-btn"
            type="button"
            disabled={disabled}
            onClick={() => void act("remove")}
          >
            {pending === "remove" ? "Removing…" : "Remove connection"}
          </button>
        )}
      </div>
    </form>
  );
}
