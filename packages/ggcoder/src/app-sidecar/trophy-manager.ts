import { randomUUID } from "node:crypto";
import { log } from "../core/logger.js";
import {
  applyDelta,
  buildTrophySnapshot,
  evaluateTrophies,
  promptDelta,
  runDelta,
  type TrophyPromptFacts,
  type TrophyRunFacts,
} from "../core/trophies/engine.js";
import { loadTrophies, updateTrophies } from "../core/trophies/store.js";
import type {
  TrophyCounter,
  TrophyDelta,
  TrophyFile,
  TrophyProgressFacts,
  TrophySnapshot,
} from "../core/trophies/types.js";

// ── Trophies ────────────────────────────────────────────────────────────
// Daemon-level, like progress: one file (~/.gg/trophies.json), writes under a
// file lock, and every snapshot broadcast to every window. A frame that earned
// trophies carries their ids and a nonce, and is tagged `origin` for the window
// whose action earned them, so that window alone plays the unlock.
// Recording never throws: a trophy must never break a run or a request.

export interface TrophyManager {
  /** Current snapshot for GET /trophies. */
  snapshot: () => TrophySnapshot;
  /** Count something that happened. */
  record: (delta: TrophyDelta, originId?: string) => Promise<void>;
  /** Shorthand for one counter. */
  count: (counter: TrophyCounter, originId?: string) => Promise<void>;
  /** A finished, successful run. Also picks up fresh XP totals. */
  recordRun: (run: TrophyRunFacts, originId?: string) => Promise<void>;
  /** A sent prompt. */
  recordPrompt: (prompt: TrophyPromptFacts, originId?: string) => Promise<void>;
}

export async function createTrophyManager(
  progressFacts: () => TrophyProgressFacts,
  broadcastAll: (snapshot: TrophySnapshot, originId?: string) => void,
  filePath?: string,
): Promise<TrophyManager> {
  const loaded = await loadTrophies(filePath);
  let file: TrophyFile = loaded.file;

  // Everyone starts from zero: nothing done before trophies existed counts.
  // The XP totals at this moment become the baseline that progress trophies
  // (runs, commits, lines, levels) are measured from. Written now, at boot, so
  // the very first run afterwards counts.
  if (loaded.fresh || !file.baseline) {
    try {
      file = (
        await updateTrophies((f) => {
          f.baseline ??= progressFacts();
        }, filePath)
      ).file;
    } catch (err) {
      log("DEBUG", "app-sidecar", "trophy baseline failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log("INFO", "app-sidecar", "trophies loaded", {
    earned: String(Object.keys(file.unlocked).length),
  });

  // One write at a time, in order, so the in-memory file is always the newest.
  let queue: Promise<void> = Promise.resolve();

  function record(delta: TrophyDelta, originId?: string): Promise<void> {
    const next = queue.then(async () => {
      try {
        const { file: updated, result: earned } = await updateTrophies((f) => {
          // If the boot-time write failed, the first event sets the baseline.
          f.baseline ??= progressFacts();
          applyDelta(f, delta);
          const ids = evaluateTrophies(f, progressFacts(), new Date());
          if (ids.length > 0) f.lastEvent = { nonce: randomUUID(), unlocked: ids };
          return ids;
        }, filePath);
        file = updated;
        if (earned.length > 0) {
          log("INFO", "app-sidecar", "trophies earned", { ids: earned.join(",") });
          broadcastAll(
            buildTrophySnapshot(file, progressFacts(), {
              unlocked: earned,
              nonce: file.lastEvent?.nonce ?? null,
            }),
            originId,
          );
        } else {
          // Progress bars move too; windows keep a fresh copy without a celebration.
          broadcastAll(buildTrophySnapshot(file, progressFacts()));
        }
      } catch (err) {
        log("DEBUG", "app-sidecar", "trophy record failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    queue = next;
    return next;
  }

  return {
    snapshot: () => buildTrophySnapshot(file, progressFacts()),
    record,
    count: (counter, originId) => record({ count: { [counter]: 1 } }, originId),
    recordRun: (run, originId) => record(runDelta(run), originId),
    recordPrompt: (prompt, originId) => record(promptDelta(prompt), originId),
  };
}
