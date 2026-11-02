export const WORKSPACE_LAYOUT_KEY = "gg-workspace-layout-recursive:main";

/** In-page script: a fresh profile opens with an empty workspace pane; give it a Code agent on `cwd`. */
export function seedAgentPaneScript(cwd: string): string {
  return `(() => {
    if (document.querySelector('.agent-pane')) return 'has-pane';
    const storage = window.localStorage;
    if (!storage || !window.location) return 'unsupported';
    let layout = null;
    try { layout = JSON.parse(storage.getItem(${JSON.stringify(WORKSPACE_LAYOUT_KEY)}) || 'null'); } catch { layout = null; }
    if (!layout || typeof layout !== 'object' || !layout.panes || typeof layout.panes !== 'object') return 'missing';
    const ids = Object.keys(layout.panes);
    const id = ids.includes(layout.focusedPaneId) ? layout.focusedPaneId : ids[0];
    if (!id || layout.panes[id] !== null) return 'not-empty';
    layout.panes[id] = { kind: 'agent', mode: 'code', cwd: ${JSON.stringify(cwd)}, sessionPath: null };
    storage.setItem(${JSON.stringify(WORKSPACE_LAYOUT_KEY)}, JSON.stringify(layout));
    window.setTimeout(() => window.location.reload(), 0);
    return 'seeded';
  })()`;
}
