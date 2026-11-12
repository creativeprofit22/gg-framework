// Fictional, local-only bridge. Never forwards calls to a desktop or provider.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import type { SidecarEvent } from "../../src/agent";

const state = {
  cwd: "/fictional/motion-fixture",
  mode: "code",
  provider: "anthropic",
  model: "fixture-model",
  running: false,
};
// Every pane the app creates gets one fictional session; events go to the latest.
const panes = new Map<string, { generation: number; sessionId: string }>();
let activePane: string | null = null;
let queuedPrompts = 0;
function openPane(paneId: string): number {
  const generation = (panes.get(paneId)?.generation ?? 0) + 1;
  panes.set(paneId, { generation, sessionId: `fixture-session-${paneId}-${generation}` });
  activePane = paneId;
  queueMicrotask(() => void emit("agent-pane-ready", { paneId, generation }));
  return generation;
}
function paneStatus(paneId: string): {
  ready: boolean;
  error: null;
  generation: number;
  sessionId: string;
} {
  const pane = panes.get(paneId);
  if (!pane) throw new Error(`pane '${paneId}' does not exist`);
  return { ready: true, error: null, ...pane };
}
export const bridge = {
  unknown: [] as string[],
  prompts: [] as unknown[],
  checklist: "loaded",
  toggleTools: (): void =>
    flushSync(() => {
      const button = document.querySelector<HTMLButtonElement>(".tools-toggle");
      if (!button) throw new Error("Fixture tool toggle is missing");
      button.click();
    }),
  // Mock IPC delivers listeners synchronously. Commit those updates before
  // returning so the runner can inspect WAAPI before its first frame.
  emit: (event: SidecarEvent): Promise<void> =>
    flushSync(() => {
      const pane = activePane === null ? undefined : panes.get(activePane);
      if (!pane) throw new Error("Fixture pane is not ready");
      if (event.type === "run_start") state.running = true;
      if (event.type === "run_end") state.running = false;
      return emit("agent-event", { paneId: activePane, sessionId: pane.sessionId, ...event });
    }),
};
mockWindows("main");
mockIPC(
  (command, payload) => {
    const paneId = String((payload as { paneId?: unknown } | undefined)?.paneId ?? "primary");
    switch (command) {
      case "agent_pane_create":
      case "agent_pane_restore":
        return openPane(paneId);
      case "agent_pane_status":
        return paneStatus(paneId);
      case "agent_pane_dispose":
        panes.delete(paneId);
        return null;
      case "agent_pane_copy_restore":
      case "window_restore_target":
        return { mode: "code", cwd: state.cwd, sessionPath: null };
      case "sidecar_port":
        return 12345;
      case "agent_state":
        return state;
      case "plugin:updater|check":
      case "window_tray_intent":
        return null;
      case "set_update_available":
      case "set_remote_active":
      case "agent_prewarm":
        return null;
      case "agent_progress":
        return {
          level: 1,
          rankName: "Fixture",
          tier: 1,
          tierName: "Fixture",
          tierGlyph: "",
          effectId: "",
          xp: 0,
          xpIntoLevel: 0,
          xpForLevel: 100,
          percent: 0,
          streak: { current: 0, best: 0 },
          totals: { prompts: 0, commits: 0, linesShipped: 0, projects: 0 },
          xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
          memberSince: "2026-10-07",
          ladder: [],
          levelUp: null,
          eventNonce: null,
        };
      case "agent_serve_status":
        return { running: false, configured: false };
      case "agent_radio_state":
        return { stations: [], current: null, volume: 0 };
      case "agent_usage":
        return {
          provider: state.provider,
          displayName: "Fixture",
          connected: false,
          windows: [],
          fetchedAt: 0,
        };
      case "agent_models":
        return { models: [{ id: state.model, provider: state.provider }] };
      case "agent_commands":
        return { commands: [{ name: "help", description: "Fixture help" }] };
      case "agent_tasks":
        return { tasks: [] };
      case "agent_history":
        return {
          history: Array.from({ length: 30 }, (_, i) => ({
            role: i % 2 ? "assistant" : "user",
            text: `Fictional conversation ${i}. ${"Reading anchor. ".repeat(10)}`,
          })),
        };
      case "agent_checklist":
        if (bridge.checklist === "loading") return new Promise(() => {});
        if (bridge.checklist === "error") throw new Error("Fictional checklist load failure");
        return {
          staleAfterDays: 30,
          detectionWarnings: [],
          items: [
            {
              id: "git-github",
              group: "Source control",
              title: "Git & GitHub",
              description: "Fictional repository",
              check: "Inspect git",
              skill: null,
              setupCommand: null,
              status: "not-run",
              checkedAt: null,
              commit: null,
              uncommittedChanges: false,
              result: null,
              summary: null,
              findings: [],
              evidence: [],
              detection: null,
              runPrompt: "Fixture only; do not execute",
            },
          ],
        };
      case "app_local_patched_update_status":
        return {
          available: false,
          currentSourceSha: "fixture",
          upstreamIntegrated: true,
          origin: "unavailable",
        };
      case "plugin:app|version":
        return "0.0.0-fixture";
      case "app_settings_get":
        return { projectsRoot: "/fictional", configured: true };
      case "app_auth_status":
        return { providers: [] };
      case "agent_trophies":
        return {
          trophies: [],
          categories: [],
          earned: 0,
          total: 0,
          unlocked: [],
          eventNonce: null,
        };
      case "agent_roadmap_phase_draft_get":
        return { status: "ok", draft: null };
      case "agent_notes_get":
        return {
          status: "ok",
          recoveredFromBackup: false,
          snapshot: {
            projectKey: "fixture-project",
            revision: 0,
            document: {
              version: 3,
              reference: "",
              currentFocus: "",
              tasks: [],
              handoff: { text: "", updatedAt: null, readAt: null },
              updatedAt: "2026-10-07T00:00:00.000Z",
              legacyImportedAt: null,
              phases: [],
              references: [],
            },
          },
        };
      case "qwen_cloud_connection_status":
        return { ok: false, code: "native-unavailable" };
      case "agent_verify_plan_status":
        return null;
      case "agent_prompt":
        bridge.prompts.push(payload);
        // Like the daemon: a prompt sent during a run waits in the queue.
        if (!state.running) return { queued: false, count: 0 };
        queuedPrompts += 1;
        return { queued: true, count: queuedPrompts, queueId: `q${queuedPrompts}`, steers: false };
      case "plugin:log|log":
      case "plugin:window|set_title":
        return null;
      default:
        bridge.unknown.push(command);
        console.error(`Unsupported fixture bridge call: ${command} ${JSON.stringify(payload)}`);
        throw new Error(`Unsupported fixture bridge call: ${command}`);
    }
  },
  { shouldMockEvents: true },
);
Object.assign(window, { motionBridge: bridge });
