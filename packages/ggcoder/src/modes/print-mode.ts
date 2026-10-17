import { AgentSession, type AgentSessionOptions } from "../core/agent-session.js";
import { isAbortError } from "@kenkaiiii/gg-agent";
import { formatUserError } from "../utils/error-handler.js";
import { initLogger, log, attachToEventBus, closeLogger } from "../core/logger.js";
import { getAppPaths } from "../config.js";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

export interface PrintModeOptions {
  message: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  systemPrompt?: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
}

export async function runPrintMode(options: PrintModeOptions): Promise<void> {
  const paths = getAppPaths();
  initLogger(paths.logFile, { provider: options.provider, model: options.model });
  log("INFO", "startup", "Print mode started");

  const ac = new AbortController();

  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);

  const sessionOpts: AgentSessionOptions = {
    unattended: true,
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    thinkingLevel: options.thinkingLevel,
    signal: ac.signal,
  };

  const session = new AgentSession(sessionOpts);
  attachToEventBus(session.eventBus);

  // Subscribe to events
  session.eventBus.on("text_delta", ({ text }) => {
    process.stdout.write(text);
  });

  session.eventBus.on("error", ({ error }) => {
    process.stderr.write(`Error: ${error.message}\n`);
  });

  try {
    await session.initialize();
    await session.prompt(options.message);
    process.stdout.write("\n");
  } catch (err) {
    if (isAbortError(err)) {
      process.stderr.write("\nInterrupted.\n");
      process.exit(130);
    }
    process.stderr.write(formatUserError(err) + "\n");
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
    await session.dispose();
    closeLogger();
  }
}
