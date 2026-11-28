export type CliSubcommandName =
  | "mcp"
  | "login"
  | "logout"
  | "sessions"
  | "telegram"
  | "serve"
  | "doctor"
  | "acp"
  | "agent-home-login"
  | "agent-home";

export type CliCommandRouteResult =
  | { kind: "handled"; subcommand: CliSubcommandName }
  | { kind: "continue" }
  | { kind: "main"; subcommand: string | undefined };

type SubcommandHandler = () => void;

export interface CliCommandRoutingOptions {
  argv: string[];
  printHelp: () => void;
  exit: (code: number) => never;
  handlers: Record<CliSubcommandName, SubcommandHandler>;
}

const SUBCOMMANDS_THAT_KEEP_ARGV: ReadonlySet<CliSubcommandName> = new Set([
  "mcp",
  "login",
  "logout",
  "telegram",
  "doctor",
  "agent-home-login",
]);

function isCliSubcommandName(value: string | undefined): value is CliSubcommandName {
  return (
    value === "mcp" ||
    value === "login" ||
    value === "logout" ||
    value === "sessions" ||
    value === "telegram" ||
    value === "serve" ||
    value === "doctor" ||
    value === "acp" ||
    value === "agent-home-login" ||
    value === "agent-home"
  );
}

function stripSubcommandArg(argv: string[]): void {
  argv.splice(2, 1);
}

/**
 * Routes the early CLI command layer before parseArgs handles normal flags.
 *
 * This intentionally preserves the legacy startup contract:
 * - any -h/--help anywhere prints top-level help and exits before subcommands;
 * - selected subcommands remove their command token before their mode parser runs;
 * - `continue` is not a standalone handler, it only toggles the later TUI resume path.
 */
export function routeCliCommandInput(options: CliCommandRoutingOptions): CliCommandRouteResult {
  const { argv, printHelp, exit, handlers } = options;

  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    exit(0);
  }

  const subcommand = argv[2];

  if (isCliSubcommandName(subcommand)) {
    if (!SUBCOMMANDS_THAT_KEEP_ARGV.has(subcommand)) {
      stripSubcommandArg(argv);
    }
    handlers[subcommand]();
    return { kind: "handled", subcommand };
  }

  if (subcommand === "continue") {
    stripSubcommandArg(argv);
    return { kind: "continue" };
  }

  return { kind: "main", subcommand };
}
