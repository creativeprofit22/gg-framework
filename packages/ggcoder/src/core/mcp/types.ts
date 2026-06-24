export interface MCPServerConfig {
  name: string;
  /** HTTP endpoint URL (Streamable HTTP or SSE) */
  url?: string;
  headers?: Record<string, string>;
  /** Stdio server: command to spawn */
  command?: string;
  /** Stdio server: command arguments */
  args?: string[];
  /** Stdio server: environment variables */
  env?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
  /** Explicit HTTP transport hint. "http" tries Streamable HTTP first (SSE
   *  fallback); "sse" connects via the legacy SSE transport directly. When
   *  unset, both are tried (Streamable HTTP → SSE). */
  transport?: "http" | "sse";
}
