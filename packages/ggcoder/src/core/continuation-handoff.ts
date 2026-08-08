import type { ContentPart, Message } from "@kenkaiiii/gg-ai";
import { z } from "zod";

export const CONTINUATION_HANDOFF_VERSION = 1 as const;

export const CONTINUATION_HANDOFF_LIMITS = {
  nextInstructionChars: 8_000,
  objectiveChars: 1_600,
  listItems: 8,
  listItemChars: 1_000,
  coordinates: 16,
  pathChars: 500,
  relevanceChars: 500,
  evidenceItems: 12,
  evidenceItemChars: 1_500,
  evidenceChars: 18_000,
  renderedPromptChars: 24_000,
} as const;

export interface ContinuationRepositoryCoordinate {
  path: string;
  startLine?: number;
  endLine?: number;
  relevance: string;
}

export interface ContinuationArtifactPath {
  path: string;
  relevance: string;
}

export interface ContinuationHandoffV1 {
  objective: string;
  verifiedWork: string[];
  decisions: string[];
  constraints: string[];
  repositoryCoordinates: ContinuationRepositoryCoordinate[];
  artifactPaths: ContinuationArtifactPath[];
  unresolvedIssues: string[];
  nextAtomicStep: string;
}

export interface ContinuationEvidenceV1 {
  version: typeof CONTINUATION_HANDOFF_VERSION;
  cwd: string;
  sourceSessionPath: string;
  objectives: string[];
  constraints: string[];
  assistantConclusions: string[];
  compactedSummaries: string[];
  repositoryCoordinates: ContinuationRepositoryCoordinate[];
  artifactPaths: ContinuationArtifactPath[];
}

export interface ContinuationEvidenceInput {
  cwd: string;
  sourceSessionPath: string;
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
const repositoryCoordinateSchema = z
  .object({
    path: boundedString(CONTINUATION_HANDOFF_LIMITS.pathChars),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
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
const artifactPathSchema = z
  .object({
    path: boundedString(CONTINUATION_HANDOFF_LIMITS.pathChars),
    relevance: boundedString(CONTINUATION_HANDOFF_LIMITS.relevanceChars),
  })
  .strict();

export const continuationHandoffV1Schema = z
  .object({
    objective: boundedString(CONTINUATION_HANDOFF_LIMITS.objectiveChars),
    verifiedWork: boundedList,
    decisions: boundedList,
    constraints: boundedList,
    repositoryCoordinates: z
      .array(repositoryCoordinateSchema)
      .max(CONTINUATION_HANDOFF_LIMITS.coordinates),
    artifactPaths: z.array(artifactPathSchema).max(CONTINUATION_HANDOFF_LIMITS.coordinates),
    unresolvedIssues: boundedList,
    nextAtomicStep: boundedString(CONTINUATION_HANDOFF_LIMITS.listItemChars),
  })
  .strict();

const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";
const ARTIFACT_PATH_PATTERN =
  /(?:^|[\\/])(?:\.gg[\\/](?:plans|screenshots|generated)|screenshots?|reports?|artifacts?|sessions?)(?:[\\/]|$)/i;
const SOURCE_EXTENSION_PATTERN =
  /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|rs|py|go|java|kt|swift|rb|php|vue|svelte|astro|sql|ya?ml|toml|json|mdx?)$/i;
const PATH_ARGUMENT_KEYS = ["file_path", "path", "plan_path", "out_path", "image"] as const;

function cap(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max).trimEnd();
}

function addUnique(
  items: string[],
  value: string,
  limit = CONTINUATION_HANDOFF_LIMITS.evidenceItems,
  preserveFirst = false,
): void {
  const bounded = cap(value, CONTINUATION_HANDOFF_LIMITS.evidenceItemChars);
  if (!bounded || items.some((item) => item.toLocaleLowerCase() === bounded.toLocaleLowerCase()))
    return;
  if (items.length >= limit) items.splice(preserveFirst ? 1 : 0, 1);
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
  if (message.provenance?.kind === "automation" || message.provenance?.kind === "notification") {
    return false;
  }
  return true;
}

function coordinateFromArgs(
  pathValue: string,
  args: Record<string, unknown>,
  toolName: string,
): ContinuationRepositoryCoordinate {
  const start = positiveInteger(args.startLine ?? args.start_line ?? args.offset);
  const explicitEnd = positiveInteger(args.endLine ?? args.end_line);
  const limit = positiveInteger(args.limit);
  const end =
    explicitEnd ?? (start !== undefined && limit !== undefined ? start + limit - 1 : undefined);
  return {
    path: cap(pathValue, CONTINUATION_HANDOFF_LIMITS.pathChars),
    ...(start === undefined ? {} : { startLine: start }),
    ...(end === undefined ? {} : { endLine: end }),
    relevance: cap(`Referenced by ${toolName}`, CONTINUATION_HANDOFF_LIMITS.relevanceChars),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function addCoordinate(
  coordinates: ContinuationRepositoryCoordinate[],
  coordinate: ContinuationRepositoryCoordinate,
): void {
  const key = `${coordinate.path.toLocaleLowerCase()}:${coordinate.startLine ?? ""}:${coordinate.endLine ?? ""}`;
  if (
    coordinates.some(
      (item) =>
        `${item.path.toLocaleLowerCase()}:${item.startLine ?? ""}:${item.endLine ?? ""}` === key,
    )
  ) {
    return;
  }
  if (coordinates.length >= CONTINUATION_HANDOFF_LIMITS.coordinates) coordinates.shift();
  coordinates.push(coordinate);
}

function addArtifact(
  artifacts: ContinuationArtifactPath[],
  path: string,
  relevance: string,
  preserveFirst = false,
): void {
  const boundedPath = cap(path, CONTINUATION_HANDOFF_LIMITS.pathChars);
  if (
    !boundedPath ||
    artifacts.some((item) => item.path.toLocaleLowerCase() === boundedPath.toLocaleLowerCase())
  ) {
    return;
  }
  if (artifacts.length >= CONTINUATION_HANDOFF_LIMITS.coordinates) {
    artifacts.splice(preserveFirst ? 1 : 0, 1);
  }
  artifacts.push({
    path: boundedPath,
    relevance: cap(relevance, CONTINUATION_HANDOFF_LIMITS.relevanceChars),
  });
}

function toolCalls(message: Extract<Message, { role: "assistant" }>): ContentPart[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((part) => part.type === "tool_call");
}

function enforceEvidenceTotalLimit(evidence: ContinuationEvidenceV1): ContinuationEvidenceV1 {
  while (JSON.stringify(evidence).length > CONTINUATION_HANDOFF_LIMITS.evidenceChars) {
    const reducible = [evidence.assistantConclusions, evidence.compactedSummaries].find(
      (items) => items.length > 1,
    );
    if (reducible) {
      reducible.shift();
      continue;
    }
    if (evidence.constraints.length > 1) {
      evidence.constraints.splice(1, 1);
      continue;
    }
    if (evidence.objectives.length > 1) {
      evidence.objectives.splice(1, 1);
      continue;
    }
    if (evidence.repositoryCoordinates.length > 1) {
      evidence.repositoryCoordinates.shift();
      continue;
    }
    if (evidence.artifactPaths.length > 1) {
      evidence.artifactPaths.splice(1, 1);
      continue;
    }
    break;
  }
  return evidence;
}

/** Build a bounded, evidence-only package. Raw tool results, system text, and media never enter it. */
export function buildContinuationEvidence(
  input: ContinuationEvidenceInput,
): ContinuationEvidenceV1 {
  const objectives: string[] = [];
  const constraints: string[] = [];
  const assistantConclusions: string[] = [];
  const compactedSummaries: string[] = [];
  const repositoryCoordinates: ContinuationRepositoryCoordinate[] = [];
  const artifactPaths: ContinuationArtifactPath[] = [];

  addArtifact(artifactPaths, input.sourceSessionPath, "Source coding session");

  for (const message of input.messages) {
    if (message.role === "user" && isEligibleUserEvidence(message)) {
      const text = textFromUserMessage(message).trim();
      if (!text) continue;
      if (
        text.startsWith(COMPACTION_SUMMARY_MARKER) ||
        message.provenance?.kind === "compaction_summary"
      ) {
        addUnique(compactedSummaries, text.replace(COMPACTION_SUMMARY_MARKER, "").trim());
      } else {
        addUnique(objectives, text, CONTINUATION_HANDOFF_LIMITS.evidenceItems, true);
        if (
          /\b(?:must|never|do not|don't|only|preserve|without|constraint|required)\b/i.test(text)
        ) {
          addUnique(constraints, text, CONTINUATION_HANDOFF_LIMITS.evidenceItems, true);
        }
      }
      continue;
    }

    if (message.role !== "assistant" || message.provenance?.visibility === "hidden") continue;
    const conclusion = textFromAssistantMessage(message);
    if (conclusion.trim()) addUnique(assistantConclusions, conclusion);

    for (const call of toolCalls(message)) {
      if (call.type !== "tool_call" || !call.args || typeof call.args !== "object") continue;
      const args = call.args as Record<string, unknown>;
      for (const key of PATH_ARGUMENT_KEYS) {
        const value = args[key];
        if (typeof value !== "string" || !value.trim()) continue;
        const isRepositoryFile =
          key === "file_path" ||
          (SOURCE_EXTENSION_PATTERN.test(value) && !ARTIFACT_PATH_PATTERN.test(value));
        const artifact =
          ["screenshot", "generate_image"].includes(call.name) ||
          (!isRepositoryFile && ARTIFACT_PATH_PATTERN.test(value));
        if (artifact) {
          addArtifact(artifactPaths, value, `Produced or referenced by ${call.name}`, true);
        } else if (isRepositoryFile) {
          addCoordinate(repositoryCoordinates, coordinateFromArgs(value, args, call.name));
        }
      }
    }
  }

  // Keep the original and latest objectives when the conversation exceeds the item cap.
  const boundedObjectives =
    objectives.length <= CONTINUATION_HANDOFF_LIMITS.evidenceItems
      ? objectives
      : [objectives[0], ...objectives.slice(-(CONTINUATION_HANDOFF_LIMITS.evidenceItems - 1))];

  return enforceEvidenceTotalLimit({
    version: CONTINUATION_HANDOFF_VERSION,
    cwd: cap(input.cwd, CONTINUATION_HANDOFF_LIMITS.pathChars),
    sourceSessionPath: cap(input.sourceSessionPath, CONTINUATION_HANDOFF_LIMITS.pathChars),
    objectives: boundedObjectives,
    constraints,
    assistantConclusions,
    compactedSummaries,
    repositoryCoordinates,
    artifactPaths,
  });
}

function extractJsonObject(response: string): unknown {
  return JSON.parse(response.trim());
}

/** Parse synthesis output strictly: malformed JSON, unknown keys, and over-limit values fail closed. */
export function parseContinuationHandoff(response: string): ContinuationHandoffV1 {
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
  return result.data;
}

const HEADINGS: ReadonlyArray<readonly [string, keyof ContinuationHandoffV1]> = [
  ["Objective", "objective"],
  ["Verified work", "verifiedWork"],
  ["Decisions", "decisions"],
  ["Constraints", "constraints"],
  ["Repository coordinates", "repositoryCoordinates"],
  ["Artifact paths", "artifactPaths"],
  ["Unresolved issues", "unresolvedIssues"],
  ["Next atomic step", "nextAtomicStep"],
];

function renderSection(
  key: keyof ContinuationHandoffV1,
  value: ContinuationHandoffV1[keyof ContinuationHandoffV1],
): string {
  if (typeof value === "string") return value;
  if (value.length === 0) return "- None recorded.";
  if (key === "repositoryCoordinates") {
    return (value as ContinuationRepositoryCoordinate[])
      .map((item) => {
        const range = item.startLine
          ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ""}`
          : "";
        return `- \`${item.path}${range}\` — ${item.relevance}`;
      })
      .join("\n");
  }
  if (key === "artifactPaths") {
    return (value as ContinuationArtifactPath[])
      .map((item) => `- \`${item.path}\` — ${item.relevance}`)
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
  sections.push(`## Ken’s next instruction\n${nextInstruction}`);
  const rendered = sections.join("\n\n");
  if (rendered.length > CONTINUATION_HANDOFF_LIMITS.renderedPromptChars) {
    throw new Error("Rendered continuation handoff exceeds its size limit.");
  }
  return rendered;
}
