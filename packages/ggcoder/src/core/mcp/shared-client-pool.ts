import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  MCPClientManager,
  type MCPClientManagerOptions,
  type MCPServerStateChange,
} from "./client.js";
import type { MCPServerConfig } from "./types.js";

export interface SharedMcpClientLease {
  readonly manager: MCPClientManager;
  readonly tools: Promise<AgentTool[]>;
  release(): Promise<void>;
}

interface SharedMcpEntry {
  manager: MCPClientManager;
  tools: Promise<AgentTool[]>;
  references: number;
  listeners: Set<(change: MCPServerStateChange) => void>;
  disposePromise?: Promise<void>;
}

type ManagerFactory = (options: MCPClientManagerOptions) => MCPClientManager;

/**
 * Daemon-scoped pool for the read-only kencode-search server.
 *
 * AgentSessions keep their own tool lists and policies; only the underlying MCP
 * client/process is shared. Entries are keyed by the complete server config so
 * project overrides never inherit another session's command, environment, or
 * credentials.
 */
export class SharedMcpClientPool {
  private readonly entries = new Map<string, SharedMcpEntry>();
  private disposed = false;

  constructor(
    private readonly createManager: ManagerFactory = (options) => new MCPClientManager(options),
  ) {}

  canShare(config: MCPServerConfig): boolean {
    return config.name === "kencode-search";
  }

  acquire(
    config: MCPServerConfig,
    options: MCPClientManagerOptions,
    onStateChange?: (change: MCPServerStateChange) => void,
  ): SharedMcpClientLease {
    if (this.disposed) throw new Error("Shared MCP client pool is disposed");
    if (!this.canShare(config)) throw new Error(`MCP server is not shareable: ${config.name}`);

    const key = configKey(config, options.modernProtocol);
    let entry = this.entries.get(key);
    if (!entry) {
      const listeners = new Set<(change: MCPServerStateChange) => void>();
      const manager = this.createManager({
        ...options,
        // kencode-search is read-only and never elicits. Omitting a per-session
        // handler prevents a shared process from routing prompts to the wrong pane.
        onElicit: undefined,
        onServerStateChange: (change) => {
          for (const listener of listeners) listener(change);
        },
      });
      entry = {
        manager,
        tools: manager.connectAll([config]),
        references: 0,
        listeners,
      };
      this.entries.set(key, entry);
    }
    entry.references += 1;
    if (onStateChange) entry.listeners.add(onStateChange);

    let released = false;
    return {
      manager: entry.manager,
      tools: entry.tools,
      release: async () => {
        if (released) return;
        released = true;
        if (onStateChange) entry!.listeners.delete(onStateChange);
        entry!.references -= 1;
        if (entry!.references > 0) return;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        await this.disposeEntry(entry!);
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.disposeEntry(entry)));
  }

  private disposeEntry(entry: SharedMcpEntry): Promise<void> {
    entry.disposePromise ??= entry.tools.catch(() => []).then(async () => entry.manager.dispose());
    return entry.disposePromise;
  }
}

function configKey(config: MCPServerConfig, modernProtocol: boolean | undefined): string {
  return JSON.stringify({
    name: config.name,
    url: config.url,
    headers: sortedRecord(config.headers),
    command: config.command,
    args: config.args,
    env: sortedRecord(config.env),
    timeout: config.timeout,
    enabled: config.enabled,
    transport: config.transport,
    modernProtocol: modernProtocol === true,
  });
}

function sortedRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}
