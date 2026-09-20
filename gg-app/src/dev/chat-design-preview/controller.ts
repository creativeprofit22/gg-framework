import { previewReady } from "./readiness.mjs";
import "./styles/reading.css";
import "./styles/role-markers.css";
import "./styles/yaatuber-light.css";
import "./styles/code-surfaces.css";
import "./styles/rank-scorecard.css";
import "./styles/rank-colors.css";
import "./styles/autopilot.css";

type Selection = { variant: "original" | "reading" | "light"; size: "15" | "16"; tracking: "current" | "normal"; paragraphs: "current" | "roomy"; cap: "off" | "on"; markers: "off" | "on"; streaming: "current" | "crisp"; code: "light" | "charcoal" };
const allowed: { [K in keyof Selection]: readonly Selection[K][] } = {
  variant: ["original", "reading", "light"], size: ["15", "16"], tracking: ["current", "normal"],
  paragraphs: ["current", "roomy"], cap: ["off", "on"], markers: ["off", "on"], streaming: ["current", "crisp"], code: ["light", "charcoal"],
};
const labels: Record<keyof Selection, string> = { variant: "Comparison", size: "Prose size", tracking: "Letter spacing", paragraphs: "Paragraph spacing", cap: "Wide-pane reading cap", markers: "Identity markers", streaming: "Streamed word reveal", code: "Code surface (Light only)" };
export function parseSelection(search: string): Selection {
  const params = new URLSearchParams(search);
  const defaults: Selection = { variant: "original", size: "15", tracking: "current", paragraphs: "current", cap: "off", markers: "off", streaming: "current", code: "light" };
  const result = { ...defaults };
  for (const key of Object.keys(allowed) as (keyof Selection)[]) {
    const value = params.get(key) ?? defaults[key];
    if (!(allowed[key] as readonly string[]).includes(value)) throw new Error(`Unsupported preview setting: ${key}`);
    Object.assign(result, { [key]: value });
  }
  return result;
}

export function startPreview(): () => void {
  if (!import.meta.env.DEV || location.pathname !== "/__chat-design-preview") return () => {};
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  const selection = parseSelection(location.search);
  const abort = new AbortController();
  root.dataset.previewInput = "keyboard";
  const setInputMode = (mode: "pointer" | "keyboard") => {
    if (root.dataset.previewInput !== mode) root.dataset.previewInput = mode;
  };
  document.addEventListener("pointerdown", () => setInputMode("pointer"), { capture: true, signal: abort.signal });
  document.addEventListener("keydown", (event) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) setInputMode("keyboard");
  }, { capture: true, signal: abort.signal });
  const controls = document.createElement("details");
  controls.dataset.chatPreviewControls = "";
  controls.hidden = new URLSearchParams(location.search).get("capture") === "1";
  const summary = document.createElement("summary");
  summary.textContent = "Preview comparison";
  controls.append(summary);
  const panel = document.createElement("div");
  panel.className = "preview-settings";
  const note = document.createElement("p");
  note.textContent = "Synthetic conversations. Settings are temporary; Original ignores all reading adjustments.";
  panel.append(note);
  const apply = () => {
    root.dataset.chatPreview = selection.variant;
    note.textContent = selection.variant === "light"
      ? "Synthetic conversations. Light is source-inspired, not fidelity-verified. Settings are temporary."
      : "Synthetic conversations. Settings are temporary; Original ignores all reading adjustments.";
    for (const key of Object.keys(allowed) as (keyof Selection)[]) root.dataset[`preview${key[0].toUpperCase()}${key.slice(1)}`] = selection[key];
  };
  for (const key of Object.keys(allowed) as (keyof Selection)[]) {
    const label = document.createElement("label");
    label.textContent = labels[key];
    const select = document.createElement("select");
    for (const value of allowed[key]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "15" || value === "16" ? `${value}px` : value;
      select.append(option);
    }
    select.value = selection[key];
    select.addEventListener("change", () => { Object.assign(selection, { [key]: select.value }); apply(); }, { signal: abort.signal });
    label.append(select); panel.append(label);
  }
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "Close comparison controls";
  close.addEventListener("click", () => { controls.open = false; summary.focus(); }, { signal: abort.signal });
  panel.append(close); controls.append(panel); document.body.append(controls);
  apply();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const ready = () => {
    if (previewReady()) {
      root.dataset.eyesReady = "true";
      dispatchEvent(new Event("chat-preview-ready"));
      return;
    }
    if (++attempts < 300) timer = setTimeout(ready, 100);
  };
  ready();
  const cleanup = () => {
    abort.abort(); clearTimeout(timer); controls.remove();
    delete root.dataset.chatPreview; delete root.dataset.eyesReady; delete root.dataset.previewInput;
    for (const key of Object.keys(allowed)) delete root.dataset[`preview${key[0].toUpperCase()}${key.slice(1)}`];
  };
  addEventListener("pagehide", cleanup, { once: true, signal: abort.signal });
  return cleanup;
}
const dispose = startPreview();
if (import.meta.hot) import.meta.hot.dispose(dispose);
