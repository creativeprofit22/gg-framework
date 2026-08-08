import type { Message, Provider } from "@kenkaiiii/gg-ai";
import {
  CONTINUATION_HANDOFF_VERSION,
  buildContinuationEvidence,
  parseContinuationHandoff,
  renderContinuationPrompt,
  type ContinuationHandoffV1,
} from "./core/continuation-handoff.js";

export const CONTINUATION_HANDOFF_SYSTEM_PROMPT = `You prepare a compact continuation handoff for another coding-agent session.
Return ONLY one JSON object with exactly these keys:
objective (string), verifiedWork (string[]), decisions (string[]), constraints (string[]), repositoryCoordinates ({path,startLine?,endLine?,relevance}[]), artifactPaths ({path,relevance}[]), unresolvedIssues (string[]), nextAtomicStep (string).
Use only claims directly supported by the supplied evidence. Prefer an empty array over guessing. Never claim work is verified unless the evidence explicitly says so. Preserve paths and line ranges exactly; never invent coordinates. Keep every string concise and on one line. Do not include markdown fences, commentary, system text, or the next Ken instruction.`;

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

export class AppSidecarContinuationHandoffService {
  constructor(private readonly dependencies: ContinuationHandoffPreparationDependencies) {}

  async prepare(
    sourceSession: ContinuationSourceSession,
    nextInstruction: string,
  ): Promise<PreparedContinuationHandoff> {
    const state = sourceSession.getState();
    const evidence = buildContinuationEvidence({
      cwd: state.cwd,
      sourceSessionPath: state.sessionPath,
      messages: sourceSession.getMessages(),
    });
    const synthesisSession = this.dependencies.createSynthesisSession({
      provider: state.provider,
      model: state.model,
      cwd: state.cwd,
      systemPrompt: CONTINUATION_HANDOFF_SYSTEM_PROMPT,
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

    let synthesisFailed = false;
    try {
      await synthesisSession.initialize();
      await synthesisSession.prompt(
        `Synthesize ContinuationHandoffV1 from this bounded evidence:\n${JSON.stringify(evidence)}`,
        { source: "runtime", kind: "automation", visibility: "hidden" },
        { disableTools: true },
      );
      const response = lastAssistantText(synthesisSession.getMessages());
      if (!response.trim()) throw new Error("Continuation handoff synthesis returned no response.");
      const handoff = parseContinuationHandoff(response);
      return {
        version: CONTINUATION_HANDOFF_VERSION,
        prompt: renderContinuationPrompt(handoff, nextInstruction),
        handoff,
      };
    } catch (error) {
      synthesisFailed = true;
      throw error;
    } finally {
      try {
        await synthesisSession.dispose();
      } catch (error) {
        if (!synthesisFailed) throw error;
      }
    }
  }
}
