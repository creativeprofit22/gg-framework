import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createSafeTauriUnlisten, type SafeTauriUnlisten } from "./tauri-listener";

// Same current-webview target as agent.ts's appWindow: window-scoped events only.
const appWindow = getCurrentWebviewWindow();

// appWindow.listen lifecycle map:
// - local-patched-update, model, tray, and window-order listeners follow
//   their owning React effect;
// - readiness listeners live only until waitForPaneReady settles;
// - each pane client owns one agent-pane-ready listener for its subscription;
// - agent-event is intentionally window-lifetime and fans out synchronously.
// Every listener that can be released receives the same guarded cleanup here.
export async function listenAppWindow<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
): Promise<SafeTauriUnlisten> {
  const unlisten = await appWindow.listen<T>(eventName, handler);
  return createSafeTauriUnlisten(unlisten, eventName);
}
