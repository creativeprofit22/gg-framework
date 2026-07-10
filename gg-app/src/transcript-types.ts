import type { PromptSegment } from "./agent";
import type { SubAgentLine } from "./SubAgentFeed";
import type { HookKind } from "./useAgentEvents";

export type Item =
  | {
      kind: "user";
      id: number;
      text: string;
      command?: boolean;
      label?: string;
      images?: string[];
      files?: string[];
      enhancements?: PromptSegment[];
      queued?: boolean;
      ken?: boolean;
      kenSent?: boolean;
    }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "ken"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  | {
      kind: "error";
      id: number;
      text?: string;
      headline?: string;
      message?: string;
      guidance?: string;
    }
  | { kind: "hook"; id: number; hook: HookKind }
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  | { kind: "generating_image"; id: number; prompt: string }
  | { kind: "plan"; id: number; reason: string }
  | { kind: "task"; id: number; title: string }
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  | {
      kind: "compaction";
      id: number;
      status: "running" | "done";
      originalCount?: number;
      newCount?: number;
    }
  | {
      kind: "autopilot";
      id: number;
      phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
      reason?: string;
      body?: string;
      /** Stable seed from persisted marker data so resumed all-clear copy doesn't flicker. */
      copySeed?: string;
    };

export interface TranscriptImage {
  /** data: URL (base64) ready to drop into <img src>. */
  src: string;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}
