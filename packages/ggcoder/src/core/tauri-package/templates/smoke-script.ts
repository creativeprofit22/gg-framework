export const SMOKE_SCRIPT_TEMPLATE = `/*__GG_MARKER__*/
import { spawn } from "node:child_process";
import path from "node:path";

const ALLOWED_ENVIRONMENT = ["APPDATA", "COMSPEC", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "PATH", "PATHEXT", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WAYLAND_DISPLAY", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];

function smokeEnvironment(environment = {}) {
  const sanitized = Object.fromEntries(ALLOWED_ENVIRONMENT.flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]]] : []));
  if (typeof sanitized.TEMP === "string") sanitized.WEBVIEW2_USER_DATA_FOLDER = path.join(sanitized.TEMP, "webview2");
  return sanitized;
}

export async function smokeExecutable(executable, { env, timeoutMs = 15_000, spawnImpl = spawn } = {}) {
  if (typeof executable !== "string" || !executable) throw new Error("Executable path is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error("Invalid smoke timeout");
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [], { env: smokeEnvironment(env), shell: false, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Smoke test timed out")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else reject(new Error(\`Smoke test failed (code=\${code ?? "none"}, signal=\${signal ?? "none"})\`));
    });
  });
}
`;
