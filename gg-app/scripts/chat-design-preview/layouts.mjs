export const layoutNames = ["one", "two", "three", "five", "six", "six-rows", "uneven"];
export const stateNames = ["completed", "empty", "activity", "error", "retry", "variants"];
export const paneCounts = { one: 1, two: 2, three: 3, five: 5, six: 6, "six-rows": 6, uneven: 6 };

export function createLayout(name, version) {
  if (!layoutNames.includes(name)) throw new Error("Unknown preview layout");
  const ids = Array.from({ length: paneCounts[name] }, (_, i) => i === 0 ? "primary" : `preview-${i + 1}`);
  const leaf = (paneId) => ({ type: "leaf", paneId });
  const split = (direction, first, second, ratio = 50) => ({
    type: "split", direction, size: { type: "ratio", value: ratio }, first, second,
  });
  const row = (items) => items.length === 1 ? leaf(items[0]) : split("horizontal", leaf(items[0]), row(items.slice(1)), 100 / items.length);
  let root;
  if (ids.length <= 3) root = row(ids);
  else if (name === "six-rows") root = split("horizontal", split("vertical", leaf(ids[0]), split("vertical", leaf(ids[1]), leaf(ids[2])), 100 / 3), split("vertical", leaf(ids[3]), split("vertical", leaf(ids[4]), leaf(ids[5])), 100 / 3));
  else root = split("vertical", row(ids.slice(0, 3)), row(ids.slice(3)), name === "uneven" ? 62 : 50);
  return {
    version, root, focusedPaneId: "primary",
    panes: Object.fromEntries(ids.map((id) => [id, { kind: "agent", mode: "code", cwd: "/synthetic/chat-preview", sessionPath: null }])),
  };
}

export function parsePreviewOptions(search) {
  const params = new URLSearchParams(search);
  const layout = params.get("layout") ?? "six";
  const variant = params.get("variant") ?? "original";
  if (!layoutNames.includes(layout) || !["original", "reading", "light"].includes(variant)) throw new Error("Invalid preview selection");
  const state = params.get("state") ?? "completed";
  if (!stateNames.includes(state)) throw new Error("Invalid preview state");
  return { layout, variant, state };
}
