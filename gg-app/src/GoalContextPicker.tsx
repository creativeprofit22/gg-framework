import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTextIcon, FolderSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";

/** Mirrors the sidecar's limit in ggcoder `core/goals-store.ts`. */
export const GOAL_CONTEXT_MAX = 20;

export interface ContextPick {
  path: string;
  kind: "folder" | "file";
}

interface Props {
  value: readonly ContextPick[];
  onChange: (next: ContextPick[]) => void;
  disabled?: boolean;
  /** A picker failure, for the modal's error line. */
  onError: (message: string) => void;
}

/** Last path segment, for a compact row label (the full path is the tooltip). */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * A goal's attached folders and files: a labelled list with an Add menu
 * (folders or files, native picker) and a remove button per row. Shared by
 * New goal and Goal settings.
 */
export function GoalContextPicker({
  value,
  onChange,
  disabled = false,
  onError,
}: Props): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const contextId = useId();
  const menuId = useId();
  const addRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: MouseEvent): void => {
      if (addRef.current && !addRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    // Escape closes only the menu, not the whole modal underneath it.
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
      addTriggerRef.current?.focus();
    };
    const id = window.setTimeout(() => document.addEventListener("mousedown", closeOnOutside), 0);
    document.addEventListener("keydown", closeOnEscape, true);
    requestAnimationFrame(() =>
      addRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(),
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  async function add(kind: "folder" | "file"): Promise<void> {
    setMenuOpen(false);
    try {
      const picked = await openDialog({
        directory: kind === "folder",
        multiple: true,
        title: kind === "folder" ? "Add folders to this goal" : "Add files to this goal",
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length > 0) {
        const seen = new Set(value.map((c) => c.path));
        const added = paths
          .filter((p) => !seen.has(p))
          .map((p): ContextPick => ({ path: p, kind }));
        onChange([...value, ...added].slice(0, GOAL_CONTEXT_MAX));
      }
    } catch (e) {
      onError(`Couldn't open the picker: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      requestAnimationFrame(() => addTriggerRef.current?.focus());
    }
  }

  return (
    <>
      <div className="goal-context-head">
        <span className="modal-label goal-context-label" id={contextId}>
          Context{" "}
          <span className="goal-optional" style={{ color: theme.textDim }}>
            {value.length > 0 ? `(${value.length} of ${GOAL_CONTEXT_MAX})` : "(optional)"}
          </span>
        </span>
        <div className="goal-add" ref={addRef}>
          <button
            ref={addTriggerRef}
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled || value.length >= GOAL_CONTEXT_MAX}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            Add
          </button>
          {menuOpen && (
            <div
              id={menuId}
              className="winlayout-menu"
              role="menu"
              aria-label="Add context"
              onKeyDown={moveMenuFocus}
              style={{ background: theme.surface2, borderColor: theme.border }}
            >
              <button
                type="button"
                role="menuitem"
                className="winlayout-item"
                onClick={() => void add("folder")}
              >
                <FolderSimpleIcon size={16} aria-hidden="true" />
                Add folders
              </button>
              <button
                type="button"
                role="menuitem"
                className="winlayout-item"
                onClick={() => void add("file")}
              >
                <FileTextIcon size={16} aria-hidden="true" />
                Add files
              </button>
            </div>
          )}
        </div>
      </div>
      {/* One fixed-height box, empty or full: the modal never grows as
          things are added; a long list scrolls inside it. */}
      <div className="goal-context-box">
        {value.length > 0 ? (
          <ul className="goal-context-list" aria-labelledby={contextId}>
            {value.map((item) => (
              <li key={item.path} className="goal-context-chip" title={item.path}>
                {item.kind === "folder" ? (
                  <FolderSimpleIcon
                    size={14}
                    aria-hidden="true"
                    className="goal-context-icon"
                    style={{ color: theme.textMuted }}
                  />
                ) : (
                  <FileTextIcon
                    size={14}
                    aria-hidden="true"
                    className="goal-context-icon"
                    style={{ color: theme.textMuted }}
                  />
                )}
                <span className="goal-context-name" style={{ color: theme.text }}>
                  {baseName(item.path)}
                </span>
                <button
                  type="button"
                  className="goal-context-remove"
                  aria-label={`Remove ${baseName(item.path)}`}
                  title="Remove"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((c) => c.path !== item.path))}
                >
                  <XIcon size={12} weight="bold" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="goal-context-empty" style={{ color: theme.textMuted }}>
            Folders and files the goal is about, like repos, specs or mock-ups.
          </div>
        )}
      </div>
    </>
  );
}
