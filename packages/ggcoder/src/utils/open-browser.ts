import { withoutQwenRuntimeSecret } from "../tools/safe-env.js";
import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Open `url` in the user's default browser. Best-effort \u2014 if the spawn fails
 * the caller is expected to print the URL so the user can copy it manually.
 *
 * Windows note: do NOT use `cmd /c start <url>` (i.e. `spawn(..., { shell: true })`).
 * cmd.exe interprets `&` as a command separator, so any OAuth URL with
 * `&client_id=...` gets truncated at the first `&` \u2014 the browser opens to
 * `https://claude.ai/oauth/authorize?code=true` and the auth provider responds
 * with "Missing client_id parameter". `rundll32 url.dll,FileProtocolHandler`
 * is the canonical Win32 URL opener: single execve, no shell parsing, no
 * `&` escaping required. (Reproduced against gg-editor 0.6.6 on Windows 11.)
 */
export function openBrowser(url: string): void {
  const isWin = platform() === "win32";
  const cmd = platform() === "darwin" ? "open" : isWin ? "rundll32.exe" : "xdg-open";
  const args = isWin ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(cmd, args, {
      env: withoutQwenRuntimeSecret(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* caller falls back to printing the URL */
  }
}
