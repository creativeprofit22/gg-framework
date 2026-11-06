import type { ContentPart, Message } from "@kenkaiiii/gg-ai";
import { z } from "zod";
import { CONTINUATION_NEXT_INSTRUCTION_MAX_CHARS } from "@kenkaiiii/gg-core/desktop-session-ux";

export const CONTINUATION_HANDOFF_VERSION = 1 as const;

export const CONTINUATION_HANDOFF_LIMITS = {
  nextInstructionChars: CONTINUATION_NEXT_INSTRUCTION_MAX_CHARS,
  objectiveChars: 1_200,
  listItems: 6,
  listItemChars: 500,
  relevantFiles: 8,
  pathChars: 500,
  relevanceChars: 250,
  evidenceItems: 12,
  evidenceItemChars: 1_500,
  evidenceChars: 18_000,
  synthesisResponseChars: 24_000,
  renderedPromptChars: 24_000,
} as const;

export interface ContinuationRelevantFile {
  path: string;
  startLine?: number;
  endLine?: number;
  relevance: string;
}

export interface ContinuationHandoffV1 {
  currentObjective: string;
  currentStatus: string[];
  relevantDecisions: string[];
  relevantFiles: ContinuationRelevantFile[];
}

export interface ContinuationEvidenceV1 {
  version: typeof CONTINUATION_HANDOFF_VERSION;
  cwd: string;
  objectives: string[];
  explicitDecisions: string[];
  assistantConclusions: string[];
  compactedSummaries: string[];
  relevantFiles: ContinuationRelevantFile[];
}

export interface ContinuationEvidenceInput {
  cwd: string;
  messages: readonly Message[];
}

const boundedString = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), "must be single-line");
const boundedList = z
  .array(boundedString(CONTINUATION_HANDOFF_LIMITS.listItemChars))
  .max(CONTINUATION_HANDOFF_LIMITS.listItems);
const boundedLineNumber = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a safe integer");
const relevantFileSchema = z
  .object({
    path: boundedString(CONTINUATION_HANDOFF_LIMITS.pathChars),
    startLine: boundedLineNumber.optional(),
    endLine: boundedLineNumber.optional(),
    relevance: boundedString(CONTINUATION_HANDOFF_LIMITS.relevanceChars),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endLine !== undefined && value.startLine === undefined) {
      context.addIssue({ code: "custom", message: "endLine requires startLine" });
    }
    if (
      value.startLine !== undefined &&
      value.endLine !== undefined &&
      value.endLine < value.startLine
    ) {
      context.addIssue({ code: "custom", message: "endLine must be at or after startLine" });
    }
  });

export const continuationHandoffV1Schema = z
  .object({
    currentObjective: boundedString(CONTINUATION_HANDOFF_LIMITS.objectiveChars),
    currentStatus: boundedList,
    relevantDecisions: boundedList,
    relevantFiles: z.array(relevantFileSchema).max(CONTINUATION_HANDOFF_LIMITS.relevantFiles),
  })
  .strict();

const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";
const SOURCE_EXTENSION_PATTERN =
  /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|rs|py|go|java|kt|swift|rb|php|vue|svelte|astro|sql|ya?ml|toml|json|mdx?|txt|log|png|jpe?g|gif|webp|svg|pdf)$/i;
const PATH_ARGUMENT_KEYS = ["file_path", "path", "plan_path", "out_path", "image"] as const;
const MODIFICATION_TOOLS = new Set(["edit", "write", "generate_image"]);
const READ_TOOLS = new Set(["read"]);
const BINDING_DECISION_PATTERN =
  /\b(?:decision|decided|constraint|required|must|never|do not|don't|only|keep|preserve|without)\b/i;

function cap(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max).trimEnd();
}

function addUnique(
  items: string[],
  value: string,
  limit: number = CONTINUATION_HANDOFF_LIMITS.evidenceItems,
): void {
  const bounded = cap(value, CONTINUATION_HANDOFF_LIMITS.evidenceItemChars);
  if (!bounded || items.some((item) => item.toLocaleLowerCase() === bounded.toLocaleLowerCase())) {
    return;
  }
  if (items.length >= limit) items.shift();
  items.push(bounded);
}

function textFromUserMessage(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function textFromAssistantMessage(message: Extract<Message, { role: "assistant" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function isEligibleUserEvidence(message: Extract<Message, { role: "user" }>): boolean {
  if (message.provenance?.visibility === "hidden") return false;
  if (message.provenance?.kind === "compaction_summary") return true;
  if (message.provenance?.source === "runtime") return false;
  return message.provenance?.kind !== "automation" && message.provenance?.kind !== "notification";
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeRange(
  args: Record<string, unknown>,
): Pick<ContinuationRelevantFile, "startLine" | "endLine"> {
  const startValue = args.startLine ?? args.start_line ?? args.offset;
  const endValue = args.endLine ?? args.end_line;
  const limitValue = args.limit;
  if (startValue === undefined && endValue === undefined && limitValue === undefined) return {};

  const startLine = positiveSafeInteger(startValue);
  if (startLine === undefined) return {};
  if (endValue !== undefined) {
    const endLine = positiveSafeInteger(endValue);
    return endLine !== undefined && endLine >= startLine ? { startLine, endLine } : {};
  }
  if (limitValue !== undefined) {
    const limit = positiveSafeInteger(limitValue);
    if (limit === undefined || limit > Number.MAX_SAFE_INTEGER - startLine + 1) return {};
    const endLine = startLine + limit - 1;
    return { startLine, endLine };
  }
  return { startLine };
}

function relevantFileFromArgs(
  path: string,
  args: Record<string, unknown>,
  toolName: string,
  sequence: number,
): { file: ContinuationRelevantFile; priority: number; sequence: number } {
  const priority = MODIFICATION_TOOLS.has(toolName) ? 2 : READ_TOOLS.has(toolName) ? 1 : 0;
  const action = priority === 2 ? "Modified" : priority === 1 ? "Read" : "Referenced";
  return {
    file: {
      path,
      ...safeRange(args),
      relevance: `${action} by ${toolName}`.slice(0, CONTINUATION_HANDOFF_LIMITS.relevanceChars),
    },
    priority,
    sequence,
  };
}

function isExactFilePath(key: (typeof PATH_ARGUMENT_KEYS)[number], value: string): boolean {
  if (!value.trim() || value.length > CONTINUATION_HANDOFF_LIMITS.pathChars) return false;
  if (/[\r\n]/.test(value)) return false;
  return key !== "path" || SOURCE_EXTENSION_PATTERN.test(value);
}

function toolCalls(message: Extract<Message, { role: "assistant" }>): ContentPart[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((part) => part.type === "tool_call");
}

function enforceEvidenceTotalLimit(evidence: ContinuationEvidenceV1): ContinuationEvidenceV1 {
  while (JSON.stringify(evidence).length > CONTINUATION_HANDOFF_LIMITS.evidenceChars) {
    const oldest = [
      evidence.objectives,
      evidence.assistantConclusions,
      evidence.compactedSummaries,
      evidence.explicitDecisions,
    ].find((items) => items.length > 1);
    if (oldest) {
      oldest.shift();
      continue;
    }
    if (evidence.relevantFiles.length > 1) {
      evidence.relevantFiles.pop();
      continue;
    }
    break;
  }
  return evidence;
}

/** Build bounded evidence only from the source session's active in-memory context window. */
export function buildContinuationEvidence(
  input: ContinuationEvidenceInput,
): ContinuationEvidenceV1 {
  const objectives: string[] = [];
  const explicitDecisions: string[] = [];
  const assistantConclusions: string[] = [];
  const compactedSummaries: string[] = [];
  const files = new Map<
    string,
    { file: ContinuationRelevantFile; priority: number; sequence: number }
  >();
  let sequence = 0;

  for (const message of input.messages) {
    if (message.role === "user" && isEligibleUserEvidence(message)) {
      const text = textFromUserMessage(message).trim();
      if (!text) continue;
      if (
        text.startsWith(COMPACTION_SUMMARY_MARKER) ||
        message.provenance?.kind === "compaction_summary"
      ) {
        const summary = text.replace(COMPACTION_SUMMARY_MARKER, "").trim();
        addUnique(compactedSummaries, summary, 1);
        for (const line of summary.split(/\r?\n/)) {
          if (/^\s*(?:[-*]\s*)?(?:decision|constraint)s?\s*:/i.test(line)) {
            addUnique(explicitDecisions, line);
          }
        }
      } else {
        addUnique(objectives, text);
        if (BINDING_DECISION_PATTERN.test(text)) addUnique(explicitDecisions, text);
      }
      continue;
    }

    if (message.role !== "assistant" || message.provenance?.visibility === "hidden") continue;
    const conclusion = textFromAssistantMessage(message).trim();
    if (conclusion) {
      addUnique(assistantConclusions, conclusion);
      for (const line of conclusion.split(/\r?\n/)) {
        if (/^\s*(?:[-*]\s*)?(?:decision|constraint)s?\s*:/i.test(line)) {
          addUnique(explicitDecisions, line);
        }
      }
    }

    for (const call of toolCalls(message)) {
      if (call.type !== "tool_call" || !call.args || typeof call.args !== "object") continue;
      const args = call.args as Record<string, unknown>;
      for (const key of PATH_ARGUMENT_KEYS) {
        const value = args[key];
        if (typeof value !== "string" || !isExactFilePath(key, value)) continue;
        const candidate = relevantFileFromArgs(value, args, call.name, sequence++);
        const dedupeKey = value.toLocaleLowerCase();
        const existing = files.get(dedupeKey);
        if (
          !existing ||
          candidate.priority > existing.priority ||
          (candidate.priority === existing.priority && candidate.sequence > existing.sequence)
        ) {
          files.set(dedupeKey, candidate);
        }
      }
    }
  }

  const relevantFiles = [...files.values()]
    .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)
    .slice(0, CONTINUATION_HANDOFF_LIMITS.relevantFiles)
    .map(({ file }) => file);

  return enforceEvidenceTotalLimit({
    version: CONTINUATION_HANDOFF_VERSION,
    cwd: cap(input.cwd, CONTINUATION_HANDOFF_LIMITS.pathChars),
    objectives,
    explicitDecisions,
    assistantConclusions,
    compactedSummaries,
    relevantFiles,
  });
}

function fallbackList(items: readonly string[]): string[] {
  const bounded: string[] = [];
  for (const item of items) {
    const value = cap(item, CONTINUATION_HANDOFF_LIMITS.listItemChars);
    if (value && !bounded.some((existing) => existing === value)) bounded.push(value);
  }
  return bounded.slice(-CONTINUATION_HANDOFF_LIMITS.listItems);
}

/** Build an extractive handoff when optional model synthesis is unavailable or invalid. */
export function buildFallbackContinuationHandoff(
  evidence: ContinuationEvidenceV1,
): ContinuationHandoffV1 {
  return continuationHandoffV1Schema.parse({
    currentObjective: cap(
      evidence.objectives.at(-1) ?? "None recorded.",
      CONTINUATION_HANDOFF_LIMITS.objectiveChars,
    ),
    currentStatus: fallbackList([
      ...evidence.compactedSummaries.slice(-1),
      ...evidence.assistantConclusions.slice(-CONTINUATION_HANDOFF_LIMITS.listItems),
    ]),
    relevantDecisions: fallbackList(evidence.explicitDecisions),
    relevantFiles: evidence.relevantFiles.slice(0, CONTINUATION_HANDOFF_LIMITS.relevantFiles),
  });
}

function extractJsonObject(response: string): unknown {
  return JSON.parse(response.trim());
}

function evidenceOrderedSelection(
  proposed: readonly string[],
  evidence: readonly string[],
): string[] {
  const supported = new Set(evidence);
  const selected = new Set(proposed);
  if (selected.size !== proposed.length || proposed.some((claim) => !supported.has(claim))) {
    throw new Error("Continuation handoff synthesis returned an unsupported claim.");
  }
  return evidence.filter(
    (claim, index) => selected.has(claim) && evidence.indexOf(claim) === index,
  );
}

function relevantFileKey(file: ContinuationRelevantFile): string {
  return JSON.stringify([file.path, file.startLine, file.endLine, file.relevance]);
}

function relevantFileCoordinates(file: ContinuationRelevantFile): string {
  return JSON.stringify([file.path, file.startLine, file.endLine]);
}

/** Parse bounded synthesis output and retain only claims supported by supplied evidence. */
export function parseContinuationHandoff(
  response: string,
  evidence?: ContinuationEvidenceV1,
): ContinuationHandoffV1 {
  if (response.length > CONTINUATION_HANDOFF_LIMITS.synthesisResponseChars) {
    throw new Error("Continuation handoff synthesis exceeded its size limit.");
  }
  let parsed: unknown;
  try {
    parsed = extractJsonObject(response);
  } catch {
    throw new Error("Continuation handoff synthesis returned malformed JSON.");
  }
  const result = continuationHandoffV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Continuation handoff synthesis returned an invalid contract.");
  }
  if (!evidence) return result.data;

  if (result.data.currentObjective !== evidence.objectives.at(-1)) {
    throw new Error("Continuation handoff synthesis returned an unsupported claim.");
  }
  const currentStatus = evidenceOrderedSelection(result.data.currentStatus, [
    ...evidence.compactedSummaries,
    ...evidence.assistantConclusions,
  ]);
  const relevantDecisions = evidenceOrderedSelection(
    result.data.relevantDecisions,
    evidence.explicitDecisions,
  );
  const sourceFiles = new Map(evidence.relevantFiles.map((file) => [relevantFileKey(file), file]));
  const coordinates = new Set<string>();
  const selectedFiles = new Set<string>();
  for (const file of result.data.relevantFiles) {
    const coordinate = relevantFileCoordinates(file);
    const key = relevantFileKey(file);
    if (coordinates.has(coordinate)) {
      throw new Error("Continuation handoff synthesis returned duplicate files.");
    }
    coordinates.add(coordinate);
    if (!sourceFiles.has(key)) {
      throw new Error("Continuation handoff synthesis returned an unsupported file claim.");
    }
    selectedFiles.add(key);
  }

  return {
    currentObjective: result.data.currentObjective,
    currentStatus,
    relevantDecisions,
    relevantFiles: evidence.relevantFiles.filter((file) =>
      selectedFiles.has(relevantFileKey(file)),
    ),
  };
}

const HEADINGS: ReadonlyArray<readonly [string, keyof ContinuationHandoffV1]> = [
  ["Current objective", "currentObjective"],
  ["Current status", "currentStatus"],
  ["Relevant decisions", "relevantDecisions"],
  ["Relevant files", "relevantFiles"],
];

function renderSection(
  key: keyof ContinuationHandoffV1,
  value: ContinuationHandoffV1[keyof ContinuationHandoffV1],
): string {
  if (typeof value === "string") return value;
  if (value.length === 0) return "None recorded.";
  if (key === "relevantFiles") {
    return (value as ContinuationRelevantFile[])
      .map((item) => {
        const range = item.startLine
          ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ""}`
          : "";
        return `- \`${item.path}${range}\` — ${item.relevance}`;
      })
      .join("\n");
  }
  return (value as string[]).map((item) => `- ${item}`).join("\n");
}

/** Render the stable envelope. The instruction is appended verbatim and never enters synthesis. */
export function renderContinuationPrompt(
  handoff: ContinuationHandoffV1,
  nextInstruction: string,
): string {
  if (!nextInstruction.trim()) throw new Error("Ken's next instruction cannot be empty.");
  if (nextInstruction.length > CONTINUATION_HANDOFF_LIMITS.nextInstructionChars) {
    throw new Error("Ken's next instruction is too long.");
  }
  const validated = continuationHandoffV1Schema.parse(handoff);
  const sections = HEADINGS.map(
    ([heading, key]) => `## ${heading}\n${renderSection(key, validated[key])}`,
  );
  sections.push(`## Immediate next action\n${nextInstruction}`);
  const rendered = sections.join("\n\n");
  if (rendered.length > CONTINUATION_HANDOFF_LIMITS.renderedPromptChars) {
    throw new Error("Rendered continuation handoff exceeds its size limit.");
  }
  return rendered;
}
