import { CHECKLIST_ITEMS, CHECKLIST_STALE_DAYS, getChecklistItem } from "./checklist-items.js";
import { detectChecklist, type ChecklistDetection } from "./checklist-detection.js";
import { checklistRunPrompt } from "./checklist-prompt.js";
import { checklistView, readChecklist, type ChecklistRow, type Result } from "./checklist-store.js";

export interface ChecklistSnapshotRow extends ChecklistRow {
  readonly detection: ChecklistDetection | null;
  readonly runPrompt: string | null;
}
export interface ChecklistSnapshot {
  readonly staleAfterDays: number;
  readonly detectionWarnings: readonly string[];
  readonly items: readonly ChecklistSnapshotRow[];
}

/** Read-only snapshot shared by the app and the agent tool. */
export async function readChecklistSnapshot(
  cwd: string,
  now: Date,
  signal?: AbortSignal,
): Promise<Result<ChecklistSnapshot>> {
  const [record, detection] = await Promise.all([
    readChecklist(cwd, now, signal),
    detectChecklist(cwd, signal),
  ]);
  if (!record.ok) return record;
  return {
    ok: true,
    value: {
      staleAfterDays: CHECKLIST_STALE_DAYS,
      detectionWarnings: detection.warnings,
      items: checklistView(CHECKLIST_ITEMS, record.value, now).map((row) => {
        const item = getChecklistItem(row.id);
        return {
          ...row,
          detection: detection.items[row.id] ?? null,
          runPrompt: item ? checklistRunPrompt(item) : null,
        };
      }),
    },
  };
}
