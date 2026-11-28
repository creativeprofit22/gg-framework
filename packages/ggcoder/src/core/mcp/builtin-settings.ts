/** Saved state for one built-in MCP server (settings `builtinMcpServers.<name>`). */
export interface BuiltinMcpSetting {
  /** Program path to run instead of the automatic lookup. */
  path?: string;
  /** Off via the panel switch; the server stays listed but never starts. */
  enabled?: boolean;
  /** Hidden for good; only deleting this key restores it. A same-name user server can stand in. */
  removed?: boolean;
}

export type BuiltinMcpSettings = Record<string, BuiltinMcpSetting>;

/** Keep only well-formed entries: a bad hand edit must not hide or break other servers. */
export function parseBuiltinMcpSettings(raw: unknown): BuiltinMcpSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: BuiltinMcpSettings = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const setting: BuiltinMcpSetting = {};
    if (typeof entry.path === "string" && entry.path.trim()) setting.path = entry.path.trim();
    if (typeof entry.enabled === "boolean") setting.enabled = entry.enabled;
    if (typeof entry.removed === "boolean") setting.removed = entry.removed;
    out[name] = setting;
  }
  return out;
}
