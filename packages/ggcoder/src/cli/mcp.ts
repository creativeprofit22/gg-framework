import chalk from "chalk";
import { ensureAppDirs, loadSavedSettings, projectScopeAllowed } from "../config.js";
import { initLogger, log, closeLogger } from "../core/logger.js";
import {
  MCPClientManager,
  loadServers,
  addServer,
  removeServer,
  getServer,
  globalMcpPath,
  projectMcpPath,
  parseMcpAddCommand,
  hiddenToolMessage,
  McpOAuthStore,
  isBuiltinServerName,
  removeBuiltinServer,
  withBuiltinServers,
  type MCPScope,
  type MCPServerConfig,
  type ScopedServer,
} from "../core/mcp/index.js";
import {
  renderMcpDashboard,
  renderScopeSelector,
  promptLine,
  promptWithBanner,
  transportSummary,
  bannerLines,
  mcpColors as C,
  type McpServerRow,
} from "../ui/mcp.js";
import { CLI_VERSION, clearVisibleScreen, requireInteractiveTTY } from "./shared.js";

const dim = chalk.hex(C.dim);
const primary = chalk.hex(C.primary);
const good = chalk.hex(C.good);
const bad = chalk.hex(C.bad);

export async function runMcp(): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "mcp", "mcp command started");

  const cwd = process.cwd();
  const sub = process.argv[3];
  const rest = process.argv.slice(4);

  try {
    if (sub === "--help" || sub === "-h") {
      printMcpHelp();
      return;
    }
    if (sub === "list") {
      await runList(cwd);
      return;
    }
    if (sub === "get") {
      await runGet(rest, cwd);
      return;
    }
    if (sub === "remove" || sub === "rm") {
      await runRemove(rest, cwd);
      return;
    }
    if (sub === "add" || sub === "add-json") {
      await runAdd(sub, rest, cwd);
      return;
    }
    if (sub) {
      process.stderr.write(`Unknown mcp subcommand: ${sub}\n`);
      printMcpHelp();
      process.exit(1);
    }

    // No subcommand → interactive dashboard.
    requireInteractiveTTY();
    await runDashboard(cwd);
  } finally {
    closeLogger();
  }
}

function printMcpHelp(): void {
  console.log(`ggcoder mcp — add and manage MCP servers

Usage:
  ggcoder mcp                              Open the interactive dashboard
  ggcoder mcp list                         List servers with live connection status
  ggcoder mcp get <name>                   Show one server's config
  ggcoder mcp add <args…>                  Add a server (claude-compatible grammar)
  ggcoder mcp add-json <name> '<json>'     Add a server from Claude-style JSON
  ggcoder mcp remove <name> [--scope s]    Remove a server

Add examples:
  ggcoder mcp add --transport http notion https://mcp.notion.com/mcp
  ggcoder mcp add --transport sse asana https://mcp.asana.com/sse
  ggcoder mcp add airtable -- npx -y airtable-mcp-server

Scopes:
  global   ~/.gg/mcp.json   (all GG Coder sessions)
  project  ./.gg/mcp.json   (the current project)

Built-in:
  drivah   Supa Drivah, started as "drivah mcp" when the program is found
           (settings builtinMcpServers.drivah.path, PATH, or the local build).
           "ggcoder mcp remove drivah" hides it for good; your own "drivah"
           server can take its place. To restore the built-in, delete
           builtinMcpServers.drivah.removed in ~/.gg/settings.json.

Configs are stored in the same { "mcpServers": { … } } shape Claude Code uses.`);
}

/** Saved servers plus built-ins, with the trust rule sessions use. */
async function loadWithBuiltins(cwd: string): Promise<{ scoped: ScopedServer[]; trust: boolean }> {
  const settings = loadSavedSettings();
  const trust = projectScopeAllowed(settings.trustProjectMcpServers, settings.trustedProjects, cwd);
  const scoped = withBuiltinServers(await loadServers(cwd), settings.builtinMcpServers, {
    allowProjectScope: trust,
  });
  return { scoped, trust };
}

export function serverScopeLabel(server: Pick<ScopedServer, "builtin" | "scope">): string {
  return server.builtin ? "built-in" : server.scope;
}

/** One server by name: a saved entry (project wins), else a visible built-in. */
async function findServer(name: string, cwd: string): Promise<ScopedServer | undefined> {
  const saved = await getServer(name, cwd);
  if (saved) return saved;
  const { scoped } = await loadWithBuiltins(cwd);
  return scoped.find((s) => s.builtin && s.config.name === name);
}

/** Connect each loaded server and join with its scope for display. */
async function buildRows(cwd: string): Promise<McpServerRow[]> {
  // Project-scope servers run repo-controlled commands; even listing them
  // spawns the process to probe status. Unless the user trusts project MCP
  // (trustProjectMcpServers), show those rows as blocked without connecting.
  const { scoped, trust: trustProject } = await loadWithBuiltins(cwd);
  if (scoped.length === 0) return [];
  const missing = scoped.filter((s) => s.unavailableReason);
  const connectable = scoped.filter(
    (s) => !s.unavailableReason && (trustProject || s.scope !== "project"),
  );
  const blocked = scoped.filter((s) => !trustProject && s.scope === "project");

  const manager = new MCPClientManager();
  try {
    const results =
      connectable.length > 0
        ? await manager.connectAllDetailed(connectable.map((s) => s.config))
        : [];
    return [
      ...connectable.map((s): McpServerRow => {
        const result = results.find((r) => r.name === s.config.name);
        return {
          config: s.config,
          scope: s.scope,
          ok: result?.ok ?? false,
          toolCount: result?.toolCount ?? 0,
          error: result?.error,
          ...(s.builtin ? { builtin: true } : {}),
          ...(result?.hidden?.length
            ? { warning: result.hidden.map(hiddenToolMessage).join("\n") }
            : {}),
        };
      }),
      ...blocked.map((s): McpServerRow => ({
        config: s.config,
        scope: s.scope,
        ok: false,
        toolCount: 0,
        error:
          "Project-scope server not connected — this repo's .gg/mcp.json runs " +
          "repo-controlled commands. Add or re-add a server in this project via " +
          "the MCP modal to trust it.",
      })),
      ...missing.map((s): McpServerRow => ({
        config: s.config,
        scope: s.scope,
        ok: false,
        toolCount: 0,
        error: s.unavailableReason,
        builtin: true,
      })),
    ];
  } finally {
    await manager.dispose();
  }
}

async function runList(cwd: string): Promise<void> {
  const rows = await buildRows(cwd);
  if (rows.length === 0) {
    console.log(dim("No MCP servers configured. Add one with `ggcoder mcp add …`."));
    return;
  }
  for (const row of rows) {
    const status = row.ok
      ? good(`🟢 ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`)
      : bad(`🔴 ${row.error ?? "failed"}`);
    const where = row.builtin ? "built-in" : row.scope;
    console.log(
      `${primary(row.config.name)} ${dim(`(${where})`)}  ${status}\n  ${dim(transportSummary(row.config))}`,
    );
    if (row.warning) console.log(bad(`  ⚠ ${row.warning.split("\n").join("\n  ⚠ ")}`));
  }
}

async function runGet(rest: string[], cwd: string): Promise<void> {
  const name = rest[0];
  if (!name) {
    process.stderr.write("Usage: ggcoder mcp get <name>\n");
    process.exit(1);
  }
  const found = await findServer(name, cwd);
  if (!found) {
    console.log(dim(`No server named "${name}".`));
    return;
  }
  console.log(primary(found.config.name) + dim(` (${serverScopeLabel(found)})`));
  if (found.unavailableReason) console.log(bad(`  ${found.unavailableReason}`));
  console.log(formatConfig(found.config));
}

function maskValue(value: string): string {
  if (value.length <= 8) return "••••";
  return value.slice(0, 4) + "…" + value.slice(-4);
}

function formatConfig(config: MCPServerConfig): string {
  const lines: string[] = [];
  if (config.url) {
    lines.push(dim("  transport: ") + "http/sse");
    lines.push(dim("  url:       ") + config.url);
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        lines.push(dim(`  header:    `) + `${k}: ${maskValue(v)}`);
      }
    }
  } else {
    lines.push(dim("  transport: ") + "stdio");
    lines.push(dim("  command:   ") + [config.command, ...(config.args ?? [])].join(" "));
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        lines.push(dim(`  env:       `) + `${k}=${maskValue(v)}`);
      }
    }
  }
  if (config.timeout) lines.push(dim("  timeout:   ") + String(config.timeout));
  return lines.join("\n");
}

function parseScopeFlag(rest: string[]): MCPScope | undefined {
  const idx = rest.findIndex((a) => a === "--scope" || a === "-s");
  if (idx === -1) return undefined;
  const value = rest[idx + 1]?.toLowerCase();
  if (value === "global" || value === "user") return "global";
  if (value === "project" || value === "local") return "project";
  return undefined;
}

async function runRemove(rest: string[], cwd: string): Promise<void> {
  const scopeValue = parseScopeArgValue(rest);
  const name = rest.find((a) => !a.startsWith("-") && a !== scopeValue);
  if (!name) {
    process.stderr.write("Usage: ggcoder mcp remove <name> [--scope global|project]\n");
    process.exit(1);
  }
  const requested = parseScopeFlag(rest);
  const scope = requested ?? (await getServer(name, cwd))?.scope;
  const removed = scope ? await removeServer(name, scope, cwd) : false;
  if (removed) {
    console.log(good(`✓ Removed "${name}" from ${scope} scope.`));
    return;
  }
  if (await hideBuiltinIfVisible(name, cwd)) {
    console.log(
      good(
        `✓ Hid the built-in "${name}" server. Add your own "${name}" server to use one in its place.`,
      ),
    );
    return;
  }
  console.log(
    dim(scope ? `No server named "${name}" in ${scope} scope.` : `No server named "${name}".`),
  );
}

/** Hide a built-in when nothing saved by that name was removed. True when it was hidden. */
async function hideBuiltinIfVisible(name: string, cwd: string): Promise<boolean> {
  if (!isBuiltinServerName(name)) return false;
  const found = await findServer(name, cwd);
  if (!found?.builtin) return false;
  await removeBuiltinServer(name);
  return true;
}

/** The token that is the value of --scope/-s, so we can exclude it as the name. */
function parseScopeArgValue(rest: string[]): string | undefined {
  const idx = rest.findIndex((a) => a === "--scope" || a === "-s");
  return idx === -1 ? undefined : rest[idx + 1];
}

/** Re-quote argv for the parser, so arguments with spaces or JSON survive. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

async function runAdd(sub: "add" | "add-json", rest: string[], cwd: string): Promise<void> {
  const secretPrefix = process.env.MCP_CLIENT_SECRET
    ? `MCP_CLIENT_SECRET=${shellQuote(process.env.MCP_CLIENT_SECRET)} `
    : "";
  const parsed = parseMcpAddCommand(
    `${secretPrefix}ggcoder mcp ${sub} ${rest.map(shellQuote).join(" ")}`,
  );
  if (!parsed.ok) {
    process.stderr.write(bad(`✗ ${parsed.error}\n`));
    process.exit(1);
  }
  const { config, scope: requestedScope } = parsed.value;

  const probeResult = await probeServer(config);
  if (probeResult.ok) {
    console.log(
      good(`✓ Connected — ${probeResult.toolCount} tool${probeResult.toolCount === 1 ? "" : "s"}.`),
    );
  } else {
    console.log(bad(`✗ Could not connect: ${probeResult.error ?? "unknown error"}`));
    console.log(dim("  Saving anyway — fix the config and retry later."));
  }

  // Non-interactive: default to project scope when no --scope was given.
  const scope: MCPScope = requestedScope ?? "project";
  const result = await addServer(config, scope, cwd);
  if (!result.ok) {
    process.stderr.write(bad(`✗ ${result.error}\n`));
    process.exit(1);
  }
  if (config.oauth?.clientId) {
    await new McpOAuthStore().setClient(
      config.name,
      config.oauth.clientId,
      parsed.value.clientSecret,
    );
  }
  const file = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
  console.log(good(`✓ Added "${config.name}" to ${scope} scope`) + dim(` (${file})`));
  if (!requestedScope) {
    console.log(dim("  Use --scope global to add it for all sessions instead."));
  }
  console.log(dim("  Restart ggcoder to load the new server."));
}

async function probeServer(
  config: MCPServerConfig,
): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const manager = new MCPClientManager();
  try {
    const result = await manager.probe(config);
    return { ok: result.ok, toolCount: result.toolCount, error: result.error };
  } finally {
    await manager.dispose();
  }
}

// ── Interactive dashboard ──────────────────────────────────────────

async function runDashboard(cwd: string): Promise<void> {
  for (;;) {
    clearVisibleScreen();
    console.log(dim("Connecting to MCP servers…"));
    const rows = await buildRows(cwd);
    clearVisibleScreen();

    const action = await renderMcpDashboard({ version: CLI_VERSION, rows });

    if (action.kind === "close") {
      console.log(dim("Closed MCP dashboard."));
      return;
    }
    if (action.kind === "retry") {
      continue;
    }
    if (action.kind === "remove") {
      const removed =
        (await removeServer(action.name, action.scope, cwd)) ||
        (await hideBuiltinIfVisible(action.name, cwd));
      console.log(
        removed
          ? good(`✓ Removed "${action.name}".`)
          : dim(`Nothing removed for "${action.name}".`),
      );
      continue;
    }
    if (action.kind === "details") {
      const found = await findServer(action.name, cwd);
      if (found) {
        clearVisibleScreen();
        console.log(
          bannerLines(CLI_VERSION, `${found.config.name} (${serverScopeLabel(found)})`).join("\n"),
        );
        if (found.unavailableReason) console.log(bad(`  ${found.unavailableReason}`));
        console.log("");
        console.log(formatConfig(found.config));
        console.log(dim("\n  Press Enter to return…"));
        await promptLine("");
      }
      continue;
    }
    if (action.kind === "add") {
      await runInteractiveAdd(cwd);
      continue;
    }
  }
}

async function runInteractiveAdd(cwd: string): Promise<void> {
  const line = await promptWithBanner(CLI_VERSION, {
    subtitle: "Add a server",
    question: "Command: ",
    hint: "Paste a `claude mcp add …` or `ggcoder mcp add …` line. Empty to go back.",
  });
  if (line === null) return;
  const parsed = parseMcpAddCommand(line);
  if (!parsed.ok) {
    console.log(bad(`✗ ${parsed.error}`));
    await pause();
    return;
  }
  const config = parsed.value.config;
  const requestedScope = parsed.value.scope;

  console.log(dim("Validating connection…"));
  const probeResult = await probeServer(config);
  if (probeResult.ok) {
    console.log(
      good(`✓ Connected — ${probeResult.toolCount} tool${probeResult.toolCount === 1 ? "" : "s"}.`),
    );
  } else {
    console.log(bad(`✗ Could not connect: ${probeResult.error ?? "unknown error"}`));
    console.log(dim("  You can still save it and fix the config later."));
  }

  const scope = requestedScope ?? (await renderScopeSelector(CLI_VERSION, cwd));
  if (!scope) return;

  const result = await addServer(config, scope, cwd, true);
  if (!result.ok) {
    console.log(bad(`✗ ${result.error}`));
    await pause();
    return;
  }
  if (config.oauth?.clientId) {
    await new McpOAuthStore().setClient(
      config.name,
      config.oauth.clientId,
      parsed.value.clientSecret,
    );
  }
  console.log(good(`✓ Added "${config.name}" to ${scope} scope.`));
  console.log(dim("  Restart ggcoder to load the new server."));
  await pause();
}

async function pause(): Promise<void> {
  await promptLine(dim("Press Enter to continue…"));
}
