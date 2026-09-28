import path from "node:path";
import { AgentSession, type AgentSessionOptions } from "../core/agent-session.js";
import { findMotionBundle, loadMotionSkills, type MotionBundle } from "../core/skills.js";
import { MOTION_SYSTEM_PROMPT } from "./motion-prompt.js";

/**
 * Motion's skill-catalog budget: double the default. The 16 KB default guards
 * against bloated untrusted skills; Motion only ever loads its own bundled
 * set, which already fills ~15 KB, so it gets room to grow.
 */
export const MOTION_SKILL_CATALOG_BYTES = 32 * 1024;

/** Reserved `chatAgent` query value the app uses to list Motion sessions. */
export const MOTION_SESSIONS_QUERY = "motion";

/** Motion's private session store, beside coder's `sessions/` and chat's `chat-sessions/`. */
export function motionSessionsDir(coderSessionsDir: string): string {
  return path.resolve(coderSessionsDir, "..", "motion-sessions");
}

export type MotionAgentOptions = Omit<
  AgentSessionOptions,
  | "systemPrompt"
  | "agentPrompt"
  | "agentRole"
  | "agentContext"
  | "promptCacheKeyPrefix"
  | "sessionRootDir"
  | "coderSlashCommands"
  | "selfCorrectionHooks"
  | "projectCustomization"
  | "skills"
  | "contextLimits"
  | "globalSubagents"
  | "loadExtensions"
  | "orchestrationPrompt"
> & {
  /** Coder's sessions dir; Motion's store is derived beside it. */
  sessionsDir: string;
};

/**
 * Quote a path for the prompt's shell examples. POSIX single quotes on
 * macOS/Linux; double quotes on Windows (paths there cannot contain `"`).
 */
function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact launcher invocation the agent must use for HyperFrames. Uses the
 * Node running this sidecar, so Motion works without a system Node install.
 */
export function motionCliCommand(bundle: MotionBundle, nodePath = process.execPath): string {
  return `${shellQuote(nodePath)} ${shellQuote(bundle.launcher)}`;
}

/** Motion's prompt with this install's concrete launcher paths filled in. */
export function buildMotionAgentPrompt(bundle: MotionBundle, nodePath = process.execPath): string {
  return MOTION_SYSTEM_PROMPT.replaceAll("{{HF}}", motionCliCommand(bundle, nodePath))
    .replaceAll("{{NODE}}", shellQuote(nodePath))
    .replaceAll("{{MOTION_BIN}}", path.join(bundle.root, "bin"))
    .replaceAll("{{MUSIC_DIR}}", motionMusicDir(bundle))
    .replaceAll("{{SFX_DIR}}", motionSfxDir(bundle))
    .replaceAll("{{HF_VERSION}}", bundle.version);
}

/** The shared licensed music library (shipped inside brag, used by every video type). */
export function motionMusicDir(bundle: MotionBundle): string {
  return path.join(bundle.skillsDir, "brag", "assets", "music");
}

/** The shared CC0 sound-effects library (shipped inside brag, used by every video type). */
export function motionSfxDir(bundle: MotionBundle): string {
  return path.join(bundle.skillsDir, "brag", "assets", "sfx");
}

/**
 * Create a Motion session: the full GG toolset, Motion's own prompt, and only
 * the bundled Motion skills. Project/global skills, extensions and coder
 * slash commands stay out so the mode is predictable for every user.
 */
export async function createMotionAgentSession(options: MotionAgentOptions): Promise<AgentSession> {
  const bundle = await findMotionBundle();
  if (!bundle) {
    throw new Error("Motion mode is unavailable: this GG install is missing its Motion bundle.");
  }
  const skills = await loadMotionSkills(bundle);
  const { sessionsDir, ...sessionOptions } = options;
  const sessionRootDir = motionSessionsDir(sessionsDir);
  const requestedSession = sessionOptions.sessionId ? path.resolve(sessionOptions.sessionId) : null;
  const resumableSession =
    requestedSession?.startsWith(`${sessionRootDir}${path.sep}`) === true
      ? requestedSession
      : undefined;

  return new AgentSession({
    ...sessionOptions,
    sessionId: resumableSession,
    agentPrompt: buildMotionAgentPrompt(bundle),
    agentRole: "primary",
    // Motion folders hold videos, not codebases; coder conventions do not apply.
    agentContext: "none",
    skills,
    contextLimits: { skillCatalogBytes: MOTION_SKILL_CATALOG_BYTES },
    promptCacheKeyPrefix: "ggmotion",
    sessionRootDir,
    coderSlashCommands: false,
    selfCorrectionHooks: false,
    projectCustomization: false,
    globalSubagents: true,
    loadExtensions: false,
    orchestrationPrompt: false,
  });
}
