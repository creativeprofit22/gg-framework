import type React from "react";
import { workflowQueuePolicyError } from "../core/workflow-busy-policy.js";
import type { ImageAttachment } from "../utils/image.js";
import { getModel } from "../core/model-registry.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { createProgrammaticReadinessReader, discoverCommands, programmaticReadinessGuidance } from "../core/command-discovery.js";
import { buildProgrammaticAdvisoryContext, parseProgrammaticAssessmentInput, renderProgrammaticAdvisoryContext } from "../core/programmatic/advisory-context.js";
import { loadCustomCommands } from "../core/custom-commands.js";
import { parseSlashCommandInput } from "../core/slash-commands.js";
import { parseReferencedFiles } from "@kenkaiiii/gg-core";
import { log } from "../core/logger.js";
import { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";
import type { CompletedItem, UserItem } from "./app-items.js";
import type { AgentInvocationOptions, UserContent } from "./hooks/useAgentLoop.js";
import { toErrorItem } from "./error-item.js";
import { UI_SLASH_COMMANDS } from "./submit-slash-commands.js";

interface PromptCommandSubmitOptions {
  cwd: string;
  trimmed: string;
  inputImages: ImageAttachment[];
  currentModel: string;
  setLastUserMessage: (message: string) => void;
  setDoneStatus: (status: { verb: string; durationMs: number; toolsUsed: string[] } | null) => void;
  finalizeSubmittedUserItem: (item: UserItem) => void;
  runAgent: (content: UserContent, invocation?: AgentInvocationOptions) => Promise<void>;
  isBusy: () => boolean;
  setLiveItems: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
  getId: () => string;
  reloadCustomCommands: () => void;
}

export async function submitPromptCommand({
  cwd,
  trimmed,
  inputImages,
  currentModel,
  setLastUserMessage,
  setDoneStatus,
  finalizeSubmittedUserItem,
  runAgent,
  isBusy,
  setLiveItems,
  getId,
  reloadCustomCommands,
}: PromptCommandSubmitOptions): Promise<boolean> {
  const guidance = (text: string) => {
    setLiveItems((prev) => [...prev, toErrorItem(new Error(text), getId())]);
    reloadCustomCommands();
    return true;
  };
  const busyError = isBusy() ? workflowQueuePolicyError(trimmed) : null;
  if (busyError) return guidance(busyError);
  if (/^\/programmatic-run(?:\s|$)/.test(trimmed)) {
    return guidance("Review and select an opportunity in Opportunities, then approve its separate task. Direct /programmatic-run does not authorize execution.");
  }
  if (!parseSlashCommandInput(trimmed)) return false;
  // Host actions have already intercepted their exact invocation shapes. The
  // palette is only a display projection, never an executable body cache.
  const promptCommandRoute = routePromptCommandInput(trimmed, PROMPT_COMMANDS)
    ?? routePromptCommandInput(trimmed, PROMPT_COMMANDS, await loadCustomCommands(cwd));
  if (!promptCommandRoute) return false;

  const { cmdName } = promptCommandRoute;
  let { fullPrompt } = promptCommandRoute;
  let invocation: AgentInvocationOptions | undefined = cmdName === "setup-programmatic"
    ? { programmaticSetupInspection: true } : undefined;
  if (cmdName === "programmatic") {
    const input = parseProgrammaticAssessmentInput(promptCommandRoute.cmdArgs);
    if (!input.success) return guidance("Use an optional focus of at most 4,000 characters without control characters (newlines and tabs are allowed).");
    if (inputImages.length || parseReferencedFiles(trimmed).files.length) return guidance("/programmatic accepts optional text only, not file references or attachments.");
    const readiness = await createProgrammaticReadinessReader(cwd)();
    const blocked = programmaticReadinessGuidance(readiness);
    if (blocked) return guidance(blocked);
    const discovery = await discoverCommands(cwd, { workspaceActions: UI_SLASH_COMMANDS, readReadiness: async () => readiness });
    const context = buildProgrammaticAdvisoryContext(input.data, discovery);
    fullPrompt += renderProgrammaticAdvisoryContext(context);
    invocation = { programmaticAdvisory: { cwd, context } };
  }
  log("INFO", "command", `Prompt command: /${cmdName}`);

  const imageCount = inputImages.filter((img) => img.kind === "image").length;
  const videoCount = inputImages.filter((img) => img.kind === "video").length;

  const modelInfo = getModel(currentModel);
  const modelSupportsImages = modelInfo?.supportsImages ?? true;
  const modelSupportsVideo = modelInfo?.supportsVideo ?? false;
  const userContent = buildUserContentWithAttachments(
    fullPrompt,
    inputImages,
    modelSupportsImages,
    modelSupportsVideo,
    modelInfo?.provider,
  );

  const userItem: UserItem = {
    kind: "user",
    text: trimmed,
    imageCount: imageCount > 0 ? imageCount : undefined,
    videoCount: videoCount > 0 ? videoCount : undefined,
    id: getId(),
  };
  setLastUserMessage(trimmed);
  setDoneStatus(null);
  finalizeSubmittedUserItem(userItem);

  try {
    if (invocation) await runAgent(userContent, invocation);
    else await runAgent(userContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", "error", msg);
    const isAbort = msg.includes("aborted") || msg.includes("abort");
    setLiveItems((prev) => [
      ...prev,
      isAbort
        ? { kind: "stopped", text: "Request was stopped.", id: getId() }
        : toErrorItem(err, getId()),
    ]);
  }

  reloadCustomCommands();
  return true;
}
