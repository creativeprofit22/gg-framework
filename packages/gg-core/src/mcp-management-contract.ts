/** One configured MCP server joined with its live connection status. */
export interface McpServerRow {
  name: string;
  scope: "global" | "project";
  /** False means intentionally disabled, not a connection or authentication failure. */
  enabled: boolean;
  ok: boolean;
  toolCount: number;
  /** Diagnostic only; may contain sensitive transport details. Do not render verbatim. */
  error?: string;
  /** Safe display discriminator; clients render fixed copy, never diagnostic text. */
  failureReason?: "trust-blocked" | "connection-failed";
  /** "http" for HTTP/SSE transports, "stdio" for spawned processes. */
  kind: "stdio" | "http";
  /** Transport summary for display (URL or command + arguments). */
  summary: string;
  requiresAuth?: boolean;
}
