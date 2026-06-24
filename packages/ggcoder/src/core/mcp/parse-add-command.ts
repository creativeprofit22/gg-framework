import type { MCPServerConfig } from "./types.js";
import type { MCPScope } from "./store.js";

/** Zero-dep discriminated-union result for expected parse failures. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ParsedAddCommand {
  config: MCPServerConfig;
  /** Requested scope, if the input carried a --scope flag. */
  scope?: MCPScope;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PREFIX_PATTERN = /^(claude|ggcoder)\s+mcp\s+add\s+/i;

/**
 * Shell-style tokenizer: splits on whitespace but respects single/double
 * quotes and backslash escapes. Good enough for `claude mcp add …` lines.
 */
function tokenize(input: string): Result<string[], string> {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && !inSingle) {
      const next = input[i + 1];
      if (next !== undefined) {
        current += next;
        hasToken = true;
        i++;
        continue;
      }
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;
      continue;
    }
    if ((ch === " " || ch === "\t" || ch === "\n") && !inSingle && !inDouble) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    return { ok: false, error: "Unbalanced quote in the command." };
  }
  if (hasToken) tokens.push(current);
  return { ok: true, value: tokens };
}

type Transport = "stdio" | "http" | "sse";

function normalizeTransport(value: string): Result<Transport | "ws", string> {
  const v = value.toLowerCase();
  if (v === "stdio") return { ok: true, value: "stdio" };
  if (v === "http" || v === "streamable-http") return { ok: true, value: "http" };
  if (v === "sse") return { ok: true, value: "sse" };
  if (v === "ws" || v === "websocket") return { ok: true, value: "ws" };
  return { ok: false, error: `Unknown transport "${value}". Use stdio, http, or sse.` };
}

function mapScope(value: string): Result<MCPScope, string> {
  const v = value.toLowerCase();
  if (v === "user" || v === "global") return { ok: true, value: "global" };
  if (v === "local" || v === "project") return { ok: true, value: "project" };
  return { ok: false, error: `Unknown scope "${value}". Use local, project, or user.` };
}

/**
 * Parse a pasted `claude mcp add …` / `ggcoder mcp add …` line (or just the
 * args after `add`) into an MCPServerConfig + requested scope.
 *
 * Grammar matches Claude Code:
 *   add [--transport t] [--env K=V]… [--header "K: V"]… [--scope s] <name> -- <command> [args…]
 *   add --transport http|sse <name> <url> [--header "K: V"]…
 */
export function parseMcpAddCommand(input: string): Result<ParsedAddCommand, string> {
  const stripped = input.trim().replace(PREFIX_PATTERN, "");
  if (!stripped.trim()) {
    return { ok: false, error: "Nothing to parse — provide a server name and command or URL." };
  }

  const tokenized = tokenize(stripped);
  if (!tokenized.ok) return tokenized;
  const tokens = tokenized.value;

  let transport: Transport | "ws" | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let scope: MCPScope | undefined;
  let timeout: number | undefined;
  let name: string | undefined;
  const positionals: string[] = [];
  let commandArgv: string[] | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // `--` ends option parsing; remainder is the literal spawn argv.
    if (tok === "--") {
      commandArgv = tokens.slice(i + 1);
      break;
    }

    const needNext = (label: string): Result<string, string> => {
      const next = tokens[i + 1];
      if (next === undefined) return { ok: false, error: `${label} expects a value.` };
      i++;
      return { ok: true, value: next };
    };

    if (tok === "--transport" || tok === "-t") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const t = normalizeTransport(next.value);
      if (!t.ok) return t;
      transport = t.value;
      continue;
    }
    if (tok === "--env" || tok === "-e") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const eq = next.value.indexOf("=");
      if (eq <= 0) return { ok: false, error: `Invalid --env "${next.value}". Use KEY=VALUE.` };
      env[next.value.slice(0, eq)] = next.value.slice(eq + 1);
      continue;
    }
    if (tok === "--header" || tok === "-H") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const colon = next.value.indexOf(":");
      if (colon <= 0) {
        return { ok: false, error: `Invalid --header "${next.value}". Use "Name: Value".` };
      }
      headers[next.value.slice(0, colon).trim()] = next.value.slice(colon + 1).trim();
      continue;
    }
    if (tok === "--scope" || tok === "-s") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const s = mapScope(next.value);
      if (!s.ok) return s;
      scope = s.value;
      continue;
    }
    if (tok === "--timeout") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const n = Number(next.value);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Invalid --timeout "${next.value}".` };
      }
      timeout = n;
      continue;
    }
    if (tok.startsWith("-")) {
      return { ok: false, error: `Unknown option "${tok}".` };
    }

    // First non-flag token is the name; the rest are positionals (e.g. url).
    if (name === undefined) {
      name = tok;
    } else {
      positionals.push(tok);
    }
  }

  if (!name) {
    return { ok: false, error: "Missing server name." };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `Invalid server name "${name}". Use only letters, numbers, hyphens, and underscores.`,
    };
  }

  if (transport === "ws") {
    return { ok: false, error: "WebSocket transport isn't supported yet." };
  }

  const effectiveTransport: Transport =
    transport ?? (commandArgv ? "stdio" : positionals.length > 0 ? "http" : "stdio");

  const config: MCPServerConfig = { name };
  if (timeout !== undefined) config.timeout = timeout;

  if (effectiveTransport === "http" || effectiveTransport === "sse") {
    const url = positionals[0];
    if (!url) {
      return {
        ok: false,
        error: `The ${effectiveTransport} transport requires a URL after the name.`,
      };
    }
    config.url = url;
    config.transport = effectiveTransport;
    if (Object.keys(headers).length > 0) config.headers = headers;
  } else {
    // stdio
    if (!commandArgv || commandArgv.length === 0) {
      return {
        ok: false,
        error: "stdio servers need a command after `--`, e.g. `name -- npx -y some-mcp-server`.",
      };
    }
    config.command = commandArgv[0];
    if (commandArgv.length > 1) config.args = commandArgv.slice(1);
    if (Object.keys(env).length > 0) config.env = env;
  }

  return scope === undefined
    ? { ok: true, value: { config } }
    : { ok: true, value: { config, scope } };
}
