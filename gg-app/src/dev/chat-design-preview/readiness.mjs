// Keep this self-contained: Playwright serializes the same predicate that the
// controller runs. No imports, captured variables, DOM writes or observers.
export function previewReady({ expectedCount, state, requireSignal = false } = {}) {
  const root = document.getElementById("root");
  const preview = window.__chatPreview;
  const ids = preview?.paneIds?.();
  const declaredState = preview?.options?.state;
  if (!root || !Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) return false;
  if (!["completed", "empty", "activity", "error", "retry", "variants"].includes(declaredState)) return false;
  if (state !== undefined && state !== declaredState) return false;
  if (expectedCount !== undefined && ids.length !== expectedCount) return false;
  if (requireSignal && root.dataset.eyesReady !== "true") return false;
  const panes = [...root.querySelectorAll(".workspace-pane-slot")];
  if (panes.length !== ids.length) return false;
  return ids.every((id) => {
    const matches = panes.filter((pane) => pane.dataset.paneId === id);
    if (matches.length !== 1) return false;
    const pane = matches[0];
    if (!pane.querySelector("textarea") || pane.querySelector('.markdown[aria-busy="true"]')) return false;
    if (declaredState === "empty") {
      // AgentPane mounts WakeScreen only after hydration succeeds with no items.
      return !pane.querySelector(".assistant-text") && Boolean(pane.querySelector('.transcript .wake-screen[aria-label="Ready to start"]'));
    }
    return [...pane.querySelectorAll('.transcript .assistant-text .markdown')].some((markdown) =>
      markdown.childElementCount > 0 && Boolean(markdown.textContent?.trim()));
  });
}
