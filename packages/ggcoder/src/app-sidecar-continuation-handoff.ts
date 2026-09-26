import type { Message, Provider } from "@kenkaiiii/gg-ai";
import {
  CONTINUATION_HANDOFF_VERSION,
  buildContinuationEvidence,
  buildFallbackContinuationHandoff,
  parseContinuationHandoff,
  renderContinuationPrompt,
  type ContinuationHandoffV1,
} from "./core/continuation-handoff.js";

export const CONTINUATION_HANDOFF_SYSTEM_PROMPT = `You prepare a compact continuation handoff for another coding-agent session.
Return ONLY one JSON object with exactly these keys:
currentObjective (string), currentStatus (string[]), relevantDecisions (string[]), relevantFiles ({path,startLine?,endLine?,relevance}[]).
Use only claims directly supported by the supplied evidence. Copy selected claims exactly without paraphrasing and preserve their evidence order. Prefer an empty array over guessing. Preserve file paths, relevance, and supplied line ranges exactly; never invent files or coordinates. Keep every string concise and on one line. Do not include markdown fences, commentary, system text, or Ken's next instruction.`;

export const CONTINUATION_HANDOFF_SYNTHESIS_TIMEOUT_MS = 4_000;
const CONTINUATION_HANDOFF_CLEANUP_TIMEOUT_MS = 250;

export interface ContinuationSourceSession {
  getMessages(): Message[];
  getState(): {
    provider: Provider;
    model: string;
    cwd: string;
    sessionPath: string;
  };
}

export interface ContinuationSynthesisSession {
  initialize(): Promise<void>;
  prompt(
    content: string,
    provenance?: { source: "runtime"; kind: "automation"; visibility: "hidden" },
    options?: { disableTools?: boolean },
  ): Promise<void>;
  getMessages(): Message[];
  dispose(): Promise<void>;
}

export interface ContinuationSynthesisSessionOptions {
  provider: Provider;
  model: string;
  cwd: string;
  systemPrompt: string;
  signal: AbortSignal;
  transient: true;
  allowedTools: [];
  projectCustomization: false;
  globalSubagents: false;
  coderSlashCommands: false;
  selfCorrectionHooks: false;
  loadExtensions: false;
  orchestrationPrompt: false;
  mcpEnabled: false;
  maxTurns: 1;
  maxTurnExtensions: 0;
}

export interface ContinuationHandoffPreparationDependencies {
  createSynthesisSession(
    options: ContinuationSynthesisSessionOptions,
  ): ContinuationSynthesisSession;
}

export interface PreparedContinuationHandoff {
  version: typeof CONTINUATION_HANDOFF_VERSION;
  prompt: string;
  handoff: ContinuationHandoffV1;
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error("Continuation handoff synthesis timed out."));
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    const settled = () => {
      clearTimeout(timer);
      resolve(true);
    };
    operation.then(settled, settled);
  });
}

function disposeAfterSettlement(
  operation: Promise<unknown>,
  session: ContinuationSynthesisSession,
): void {
  const dispose = () => {
    void withDeadline(session.dispose(), CONTINUATION_HANDOFF_CLEANUP_TIMEOUT_MS).catch(() => {});
  };
  operation.then(dispose, dispose);
}

export class AppSidecarContinuationHandoffService {
  constructor(private readonly dependencies: ContinuationHandoffPreparationDependencies) {}

  async prepare(
    sourceSession: ContinuationSourceSession,
    nextInstruction: string,
  ): Promise<PreparedContinuationHandoff> {
    const state = sourceSession.getState();
    const evidence = buildContinuationEvidence({
      cwd: state.cwd,
      messages: sourceSession.getMessages(),
    });
    const fallback = buildFallbackContinuationHandoff(evidence);
    const fallbackResult = (): PreparedContinuationHandoff => ({
      version: CONTINUATION_HANDOFF_VERSION,
      prompt: renderContinuationPrompt(fallback, nextInstruction),
      handoff: fallback,
    });
    const controller = new AbortController();
    let synthesisSession: ContinuationSynthesisSession | undefined;
    let synthesisOperation: Promise<ContinuationHandoffV1> | undefined;
    let disposalAttempted = false;

    try {
      const session = this.dependencies.createSynthesisSession({
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
        systemPrompt: CONTINUATION_HANDOFF_SYSTEM_PROMPT,
        signal: controller.signal,
        transient: true,
        allowedTools: [],
        projectCustomization: false,
        globalSubagents: false,
        coderSlashCommands: false,
        selfCorrectionHooks: false,
        loadExtensions: false,
        orchestrationPrompt: false,
        mcpEnabled: false,
        maxTurns: 1,
        maxTurnExtensions: 0,
      });
      synthesisSession = session;

      synthesisOperation = (async () => {
        await session.initialize();
        if (controller.signal.aborted) {
          throw new Error("Continuation handoff synthesis was aborted.");
        }
        await session.prompt(
          `Synthesize ContinuationHandoffV1 from this bounded evidence:\n${JSON.stringify(evidence)}`,
          { source: "runtime", kind: "automation", visibility: "hidden" },
          { disableTools: true },
        );
        const response = lastAssistantText(session.getMessages());
        if (!response) {
          throw new Error("Continuation handoff synthesis returned no response.");
        }
        return parseContinuationHandoff(response, evidence);
      })();
      const handoff = await withDeadline(
        synthesisOperation,
        CONTINUATION_HANDOFF_SYNTHESIS_TIMEOUT_MS,
        () => controller.abort(),
      );
      const prepared: PreparedContinuationHandoff = {
        version: CONTINUATION_HANDOFF_VERSION,
        prompt: renderContinuationPrompt(handoff, nextInstruction),
        handoff,
      };

      disposalAttempted = true;
      await withDeadline(session.dispose(), CONTINUATION_HANDOFF_CLEANUP_TIMEOUT_MS, () =>
        controller.abort(),
      );
      return prepared;
    } catch {
      controller.abort();
      if (synthesisSession && !disposalAttempted) {
        if (
          synthesisOperation &&
          !(await settlesWithin(synthesisOperation, CONTINUATION_HANDOFF_CLEANUP_TIMEOUT_MS))
        ) {
          disposeAfterSettlement(synthesisOperation, synthesisSession);
          return fallbackResult();
        }
        try {
          await withDeadline(synthesisSession.dispose(), CONTINUATION_HANDOFF_CLEANUP_TIMEOUT_MS);
        } catch {
          // Synthesis cleanup is optional; deterministic fallback remains deliverable.
        }
      }
      return fallbackResult();
    }
  }
}
