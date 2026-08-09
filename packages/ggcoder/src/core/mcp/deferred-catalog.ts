import type { AgentTool } from "@kenkaiiii/gg-agent";

/**
 * Holds MCP tools OUT of the per-turn request payload until the model asks
 * for them via `tool_search`.
 *
 * Measured: injecting every MCP tool schema
 * eagerly cost ~33KB (~8.3k tokens) per cache-miss turn with just two MCP
 * servers connected — 56% of all billed input tokens in a 6-turn session.
 * Deferring keeps the tool prefix small and byte-stable; promotion is a
 * one-time cache break paid only when a capability is actually needed.
 */
export class DeferredToolCatalog {
  private byName = new Map<string, AgentTool>();

  add(tools: AgentTool[]): void {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  /** Remove tools (e.g. when their MCP server is reloaded/removed). */
  removeWhere(predicate: (name: string) => boolean): void {
    for (const name of [...this.byName.keys()]) {
      if (predicate(name)) this.byName.delete(name);
    }
  }

  get size(): number {
    return this.byName.size;
  }

  /** Names still waiting in the catalog (for "no match" tool output). */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Rank catalog tools against a free-text capability query.
   * Word-overlap scoring: name hits weigh 3×, description hits 1×.
   */
  search(query: string, limit = 5): AgentTool[] {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    if (words.length === 0) return [];
    const scored: { tool: AgentTool; score: number }[] = [];
    for (const tool of this.byName.values()) {
      const name = tool.name.toLowerCase();
      const desc = tool.description.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 3;
        if (desc.includes(w)) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.tool);
  }

  /** Remove the named tools from the catalog and return them for activation. */
  promote(names: string[]): AgentTool[] {
    const promoted: AgentTool[] = [];
    for (const name of names) {
      const tool = this.byName.get(name);
      if (tool) {
        this.byName.delete(name);
        promoted.push(tool);
      }
    }
    return promoted;
  }
}
