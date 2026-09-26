import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";
import {
  deleteJiwa,
  deleteMemory,
  isJiwaChangeEvent,
  isMemoryChangeEvent,
  listJiwa,
  listMemories,
  subscribe,
  type JiwaEntry,
  type JiwaSnapshot,
  type Memory,
  type MemorySnapshot,
} from "./agent";
import { Badge } from "./Badge";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
}

type BrainTab = "memories" | "jiwa";
type BrainEntry = Memory | JiwaEntry;

const EMPTY_MEMORY_SNAPSHOT: MemorySnapshot = { memories: [], softLimit: 60, hardLimit: 90 };
const EMPTY_JIWA_SNAPSHOT: JiwaSnapshot = { jiwa: [], softLimit: 60, hardLimit: 90 };

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function MemoryModal({ onClose }: Props): React.ReactElement {
  const [activeTab, setActiveTab] = useState<BrainTab>("memories");
  const [memories, setMemories] = useState<MemorySnapshot>(EMPTY_MEMORY_SNAPSHOT);
  const [jiwa, setJiwa] = useState<JiwaSnapshot>(EMPTY_JIWA_SNAPSHOT);
  const [loading, setLoading] = useState<Record<BrainTab, boolean>>({
    memories: true,
    jiwa: true,
  });
  const [errors, setErrors] = useState<Record<BrainTab, string | null>>({
    memories: null,
    jiwa: null,
  });
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const memoryTabRef = useRef<HTMLButtonElement>(null);
  const jiwaTabRef = useRef<HTMLButtonElement>(null);

  const refreshMemories = useCallback(async (): Promise<void> => {
    try {
      setMemories(await listMemories());
      setErrors((current) => ({ ...current, memories: null }));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        memories: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setLoading((current) => ({ ...current, memories: false }));
    }
  }, []);

  const refreshJiwa = useCallback(async (): Promise<void> => {
    try {
      setJiwa(await listJiwa());
      setErrors((current) => ({ ...current, jiwa: null }));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        jiwa: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setLoading((current) => ({ ...current, jiwa: false }));
    }
  }, []);

  useEffect(() => {
    void refreshMemories();
    void refreshJiwa();
    return subscribe((event) => {
      if (isMemoryChangeEvent(event)) void refreshMemories();
      if (isJiwaChangeEvent(event)) void refreshJiwa();
    });
  }, [refreshJiwa, refreshMemories]);

  const remove = useCallback(async (tab: BrainTab, entry: BrainEntry): Promise<void> => {
    const key = `${tab}:${entry.id}`;
    setDeletingKey(key);
    try {
      if (tab === "memories") setMemories(await deleteMemory(entry.id));
      else setJiwa(await deleteJiwa(entry.id));
      setErrors((current) => ({ ...current, [tab]: null }));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [tab]: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setDeletingKey((current) => (current === key ? null : current));
    }
  }, []);

  const selectTab = useCallback((tab: BrainTab, focus = false): void => {
    setActiveTab(tab);
    if (focus) {
      const target = tab === "memories" ? memoryTabRef.current : jiwaTabRef.current;
      target?.focus();
    }
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      let next: BrainTab | null = null;
      if (event.key === "ArrowLeft" || event.key === "Home") next = "memories";
      if (event.key === "ArrowRight" || event.key === "End") next = "jiwa";
      if (!next) return;
      event.preventDefault();
      selectTab(next, true);
    },
    [selectTab],
  );

  const entries: BrainEntry[] = activeTab === "memories" ? memories.memories : jiwa.jiwa;
  const label = activeTab === "memories" ? "memories" : "Jiwa";
  const entryLabel = activeTab === "memories" ? "Memory" : "Instruction";
  const error = errors[activeTab];
  const isLoading = loading[activeTab];

  return (
    <Modal
      title={
        <span className="memory-modal-title">
          <span>Brain</span>
          {!isLoading && <Badge>{entries.length}</Badge>}
          <span className="brain-tabs" role="tablist" aria-label="Brain contents">
            <button
              ref={memoryTabRef}
              id="brain-tab-memories"
              type="button"
              role="tab"
              aria-selected={activeTab === "memories"}
              aria-controls="brain-panel"
              tabIndex={activeTab === "memories" ? 0 : -1}
              onClick={() => selectTab("memories")}
              onKeyDown={onTabKeyDown}
            >
              Memories
            </button>
            <button
              ref={jiwaTabRef}
              id="brain-tab-jiwa"
              type="button"
              role="tab"
              aria-selected={activeTab === "jiwa"}
              aria-controls="brain-panel"
              tabIndex={activeTab === "jiwa" ? 0 : -1}
              onClick={() => selectTab("jiwa")}
              onKeyDown={onTabKeyDown}
            >
              Jiwa
            </button>
          </span>
        </span>
      }
      onClose={onClose}
      className="memory-modal"
    >
      <div
        id="brain-panel"
        className="memory-table-wrap"
        role="tabpanel"
        aria-labelledby={`brain-tab-${activeTab}`}
      >
        {isLoading ? (
          <div className="memory-modal-state">Loading {label}…</div>
        ) : error ? (
          <div className="memory-modal-state memory-modal-error" role="alert">
            Couldn’t load {label}: {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="memory-modal-state">
            {activeTab === "memories" ? "No durable memories yet." : "No Jiwa instructions yet."}
          </div>
        ) : (
          <table className="memory-table">
            <thead>
              <tr>
                <th>{entryLabel}</th>
                <th>Category</th>
                <th>Importance</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="memory-table-text">{entry.text}</td>
                  <td>
                    <span className="memory-category">{entry.category}</span>
                  </td>
                  <td
                    className="memory-importance"
                    aria-label={`Importance ${entry.importance} of 5`}
                  >
                    {entry.importance} / 5
                  </td>
                  <td className="memory-updated">{updatedLabel(entry.updatedAt)}</td>
                  <td className="memory-delete-cell">
                    <button
                      type="button"
                      className="memory-delete"
                      aria-label={`Delete ${activeTab === "memories" ? "memory" : "Jiwa instruction"}: ${entry.text}`}
                      title={activeTab === "memories" ? "Delete memory" : "Delete Jiwa instruction"}
                      disabled={deletingKey === `${activeTab}:${entry.id}`}
                      onClick={() => void remove(activeTab, entry)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
