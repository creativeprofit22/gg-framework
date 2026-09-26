import { initScript, responses } from "../capture-screenshots.mjs";
import { normalProgressSnapshot } from "./progress-fixtures.mjs";

export const representativeReply = `This is a synthetic reading fixture, not a report of completed engineering work.

## Keep the useful character

The terminal gremlins may keep their tiny hard hats. The question here is whether a long explanation remains comfortable while the other panes show different parts of the same task. Names, controls, jokes and caveats belong in the comparison, not outside it.

Read the explanation before choosing a treatment. A larger type size may improve one pane while making another require more scrolling. A light surface may feel pleasant briefly but distracting across six panes. Neither observation establishes a medical benefit.

- Preserve the current workspace structure.
  - Compare one setting at a time.
  - Keep the composer and activity controls available.
- Check a long path: \`src/workspace/really-long-project-name/independent-preview-and-measurement/contracts/reading-anchor.ts\`.
- Follow the [local comparison notes](#__comparison-notes) without fetching an external website.

\`\`\`typescript
// Synthetic example; no code is executed.
const selection = { size: 15, spacing: "current" };
function describeReading(width: number) {
  return width > 1000 ? "Compare a bounded prose rail" : "Keep the available width";
}
\`\`\`

| State | What to observe | Caveat |
| --- | --- | --- |
| Completed | Paragraph rhythm and code wrapping | Synthetic content |
| Streaming | Reading anchor and crispness | Mock native events |
| Resizing | Draft, focus and usable height | Browser only |

> A screenshot is evidence of pixels, not proof of comfort or native behavior.

## A longer explanation

When a conversation crosses several screens, paragraph separation can help locate the next thought. Too much separation can also hide the relationship between a caveat and the statement it qualifies. Preserve those relationships and compare the same reply rather than a flattering short sample.

The reading anchor matters as much as the palette. Someone reviewing an earlier paragraph should remain there when new text arrives below. Resizing should not erase their draft or move keyboard focus to a neighboring pane. These properties need interaction tests, not optimistic captions.

No tests, deployments, commits or account connections were performed by this fictional conversation. The preview will record actual verification separately.
`;

export function fixtureResponses(state = "completed") {
  return {
    ...responses,
    agent_progress: normalProgressSnapshot(),
    sidecar_port: null,
    agent_state: { ...responses.agent_state, cwd: "/synthetic/chat-preview", sessionId: "preview-session", gitHubRepoUrl: null },
    agent_projects: { projects: [{ name: "Synthetic comparison", path: "/synthetic/chat-preview", sources: ["gg-coder"] }] },
    agent_sessions: { sessions: [] },
    agent_pane_restore: 1,
    agent_prompt: state === "variants" ? { queued: true, count: 1, queueId: "q1" } : { queued: false, count: 0 },
    agent_roadmap_phase_draft_get: { status: "ok", draft: null },
    agent_history: { history: state === "empty" ? [] : [
      { role: "user", text: "Compare this long reply without changing the installed app." },
      { role: "assistant", text: representativeReply },
      { role: "assistant", ken: true, text: "Keep the gremlins. This is a visual fixture, not a real review verdict." },
      ...(state === "variants" ? [
        { role: "user", command: true, text: "/preview-fixture" },
        { role: "user", ken: true, text: "@Ken: compare this synthetic user bubble." },
        { role: "user", kenSent: true, text: "Synthetic forwarded prompt; no request was sent." },
        { role: "user", compacted: true, compactionCounts: { originalCount: 12, newCount: 4 }, text: "Synthetic compaction notice" },
        { role: "assistant", text: "Special message shapes above are fixture-only; their original rendering path is preserved." },
      ] : []),
      ...(state === "error" ? [{ role: "assistant", text: "", error: { scope: "agent", headline: "Synthetic provider failure", message: "No model request was made.", guidance: "Use the preview controls to compare another state." } }] : []),
    ] },
  };
}

// Serialized into the preview document, never imported into the browser graph.
export function bootstrapPreview(payload) {
  const memoryStorage = () => {
    const values = new Map();
    return { get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => { values.set(String(key), String(value)); },
      removeItem: (key) => { values.delete(String(key)); }, clear: () => values.clear() };
  };
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: memoryStorage(), configurable: true });
  localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify(payload.layout));
  window.__chatPreview = { options: payload.options, errors: [], ready: false };
  const recordError = (message) => { if (window.__chatPreview.errors.length < 100) window.__chatPreview.errors.push(message); };
  addEventListener("error", (event) => recordError(event.message));
  addEventListener("unhandledrejection", (event) => recordError(String(event.reason)));
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  const transform = internals.transformCallback;
  const unregister = internals.unregisterCallback;
  const handlers = new Map();
  const callbacks = new Map();
  window.__chatPreview.listenerStats = () => ({ callbacks: callbacks.size, dispatch: handlers.size });
  let mockAutopilot = false;
  // Only synthetic code targets are supported. Bound both registry size and IDs.
  const panes = new Map();
  window.__chatPreview.paneIds = () => [...panes.keys()];
  let nextGeneration = 1;
  const validateTarget = (target) => {
    if (target?.mode !== "code" || target.cwd !== "/synthetic/chat-preview" || target.sessionPath != null) {
      throw new Error("Unsupported synthetic pane target");
    }
    return { mode: "code", cwd: target.cwd, sessionPath: null };
  };
  const bindPane = (paneId, target) => {
    if (typeof paneId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(paneId)) throw new Error("Invalid synthetic pane ID");
    const validated = validateTarget(target);
    if (!panes.has(paneId) && panes.size >= 12) throw new Error("Synthetic pane limit reached");
    const generation = nextGeneration++;
    const pane = { ...validated, generation, sessionId: `preview-session-${paneId}-${generation}` };
    panes.set(paneId, pane);
    return pane;
  };
  const requirePane = (paneId) => {
    const pane = panes.get(paneId);
    if (!pane) throw new Error(`pane '${paneId}' does not exist`);
    return pane;
  };
  for (const [paneId, target] of Object.entries(payload.layout.panes)) {
    if (target?.cwd) bindPane(paneId, target);
  }
  internals.transformCallback = (callback) => { const id = transform(callback); callbacks.set(id, callback); return id; };
  internals.unregisterCallback = (id) => { callbacks.delete(id); handlers.delete(id); unregister(id); };
  internals.invoke = async (cmd, args) => {
    // Native log calls otherwise disappear in the screenshot mock, hiding cleanup failures.
    if (cmd === "plugin:log|log" && args?.level === 5 && String(args.message).startsWith("Tauri listener cleanup failed (")) {
      recordError(String(args.message));
    }
    const paneId = args?.paneId ?? "primary";
    if (cmd === "agent_pane_create" || cmd === "agent_pane_restore" || cmd === "select_project") {
      const current = panes.get(paneId);
      validateTarget(args);
      if (cmd === "select_project" && args.expectedGeneration !== requirePane(paneId).generation) {
        throw new Error("Synthetic pane generation was superseded");
      }
      // Restore is idempotent for the preseeded target, including StrictMode remounts.
      if (cmd === "agent_pane_restore" && current) return current.generation;
      if (cmd === "agent_pane_create" && current) throw new Error("Synthetic pane already exists");
      return bindPane(paneId, args).generation;
    }
    if (cmd === "agent_pane_dispose") {
      const current = panes.get(paneId);
      if (current && args?.generation != null && args.generation !== current.generation) throw new Error("Synthetic pane generation was superseded");
      panes.delete(paneId);
      return null;
    }
    if (cmd === "plugin:event|listen") {
      const eventId = await invoke(cmd, args);
      if (args.event === "agent-event" && callbacks.has(args.handler)) handlers.set(args.handler, eventId);
      return eventId;
    }
    if (cmd === "agent_roadmap_phase_draft_get" && payload.options.state === "retry" && !window.__chatPreview.allowRetry) return Promise.reject(new Error("Synthetic review unavailable; retry is a mock."));
    if (cmd === "agent_autopilot_set") {
      if (typeof args?.enabled !== "boolean") return Promise.reject(new Error("Invalid synthetic Autopilot setting"));
      mockAutopilot = args.enabled;
      for (const paneId of panes.keys()) window.__chatPreview.emit(paneId, "autopilot", { autopilot: mockAutopilot });
      return Promise.resolve({ autopilot: mockAutopilot });
    }
    if (cmd === "agent_state") {
      const pane = requirePane(paneId);
      return { ...payload.responses.agent_state, mode: pane.mode, cwd: pane.cwd, sessionPath: pane.sessionPath, sessionId: pane.sessionId, autopilot: mockAutopilot };
    }
    if (cmd === "agent_pane_status") {
      const pane = requirePane(paneId);
      return { paneId, generation: pane.generation, ready: true, error: null, sessionId: pane.sessionId };
    }
    return invoke(cmd, args);
  };
  window.__chatPreview.emit = (paneId, type, data = {}) => {
    const pane = requirePane(paneId);
    for (const [handler, id] of handlers) callbacks.get(handler)?.({ event: "agent-event", id,
      payload: { paneId, sessionId: pane.sessionId, type, data } });
  };
  addEventListener("chat-preview-ready", () => {
    if (payload.options.state !== "activity") return;
    for (const paneId of panes.keys()) {
      window.__chatPreview.emit(paneId, "run_start");
      window.__chatPreview.emit(paneId, "tool_call_start", { toolCallId: "synthetic-read", name: "read", args: { file_path: "/synthetic/preview-only.ts" } });
    }
  }, { once: true });
  // CSP forbids blob workers. Select Vite's main-thread WebSocket reconnect ping
  // before its module runs, without relaxing the preview's network policy.
  Object.defineProperty(window, "SharedWorker", { value: undefined, configurable: true });
  // Never allow a fetch to become a fallback native/daemon/model transport.
  window.fetch = () => Promise.reject(new Error("Network fetch disabled in chat preview"));
  window.EventSource = class { constructor() { throw new Error("EventSource disabled in chat preview"); } };
}

export function fixtureScript(payload) {
  const json = JSON.stringify(payload).replaceAll("<", "\\u003c");
  return `(${initScript.toString()})(${json});\n(${bootstrapPreview.toString()})(${json});`;
}
