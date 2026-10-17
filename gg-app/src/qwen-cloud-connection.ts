import { invoke } from "@tauri-apps/api/core";
import type { QwenCloudConnectionErrorCode, QwenCloudConnectionResult } from "@kenkaiiii/gg-core";

export const QWEN_CONNECTION_ERRORS: Record<QwenCloudConnectionErrorCode, string> = {
  "invalid-key-format": "Enter a Token Plan key beginning with sk-sp- (no spaces).",
  "native-unavailable":
    "Qwen Cloud setup requires the desktop app's native connection service. No browser fallback is available.",
  "vault-unavailable": "The credential vault is unavailable. Unlock it and try again.",
  "active-run": "Finish or cancel every active run before changing this connection.",
  "preparation-failed":
    "The connection was not changed because the app could not prepare the update. Restart the app and retry.",
  "reload-failed":
    "The connection changed, but models could not refresh. Restart the app before using Qwen Cloud.",
  "authentication-failed": "Qwen Cloud rejected this Token Plan key.",
  "allowance-exhausted": "The Token Plan allowance is exhausted. Check the Qwen console.",
  "rate-limited": "Qwen Cloud rate-limited the request. Try again later.",
  "network-failed": "Qwen Cloud could not be reached. Check your network connection.",
  "request-rejected": "Qwen Cloud rejected the connection test.",
  "timed-out": "The connection test timed out. Try again later.",
};

export function qwenConnectionError(code: unknown): string {
  return typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(QWEN_CONNECTION_ERRORS, code)
    ? QWEN_CONNECTION_ERRORS[code as QwenCloudConnectionErrorCode]
    : "The Qwen Cloud connection action failed. Try again.";
}

export async function qwenCloudConnection(
  action: "status" | "save" | "remove" | "test",
  apiKey?: string,
): Promise<QwenCloudConnectionResult> {
  try {
    return await invoke<QwenCloudConnectionResult>(
      `qwen_cloud_connection_${action}`,
      action === "save" || action === "test" ? { connection: { apiKey } } : undefined,
    );
  } catch {
    // Never display/log rejected IPC data: it may contain an echoed credential.
    return { ok: false, code: "native-unavailable" };
  }
}
