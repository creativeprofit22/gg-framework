import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { theme } from "./theme";

type Direction = "up" | "down";

interface Props {
  taskText: string;
  /** Move bounds for open rows; null for completed rows, which have no Move. */
  move: { canMoveUp: boolean; canMoveDown: boolean } | null;
  /** Receives the trigger so the list can return focus to it after an action. */
  triggerRef(element: HTMLButtonElement | null): void;
  /** Receives each visible move arrow, for the same focus return. */
  moveButtonRef(direction: Direction, element: HTMLButtonElement | null): void;
  onTriggerKeyDown?(event: React.KeyboardEvent<HTMLButtonElement>): void;
  onMoveButtonKeyDown(
    direction: Direction,
  ): (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onMove(direction: Direction, source: "arrow" | "menu"): void;
  onEdit(): void;
  onArchive(): void;
}

interface MenuItem {
  key: string;
  label: string;
  /** Visible shortcut hint; the item also exposes it through aria-keyshortcuts. */
  shortcut?: { hint: string; aria: string };
  disabled: boolean;
  danger: boolean;
  separatorBefore: boolean;
  onSelect(): void;
}

/**
 * One quiet "⋯" trigger per task row that opens Move / Edit / Archive.
 * Escape is handled on the menu itself and stopped there, so it closes only the
 * menu and never the surrounding Notes dialog (which listens on document).
 */
export function NotesTaskRowActions({
  taskText,
  move,
  triggerRef,
  moveButtonRef,
  onTriggerKeyDown,
  onMoveButtonKeyDown,
  onMove,
  onEdit,
  onArchive,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerElement = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items: MenuItem[] = [
    ...(move
      ? [
          {
            key: "up",
            label: "Move up",
            shortcut: { hint: "Alt+↑", aria: "Alt+ArrowUp" },
            disabled: !move.canMoveUp,
            danger: false,
            separatorBefore: false,
            onSelect: () => onMove("up", "menu"),
          },
          {
            key: "down",
            label: "Move down",
            shortcut: { hint: "Alt+↓", aria: "Alt+ArrowDown" },
            disabled: !move.canMoveDown,
            danger: false,
            separatorBefore: false,
            onSelect: () => onMove("down", "menu"),
          },
        ]
      : []),
    {
      key: "edit",
      label: "Edit",
      disabled: false,
      danger: false,
      separatorBefore: false,
      onSelect: onEdit,
    },
    {
      key: "archive",
      label: "Archive",
      disabled: false,
      danger: true,
      separatorBefore: true,
      onSelect: onArchive,
    },
  ];

  useEffect(() => {
    if (!open) return;
    enabledItems(menuRef.current)[0]?.focus();
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) triggerElement.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = enabledItems(event.currentTarget);
    if (enabled.length === 0) return;
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };

  return (
    <div className="notes-task-tools">
      {move &&
        (["up", "down"] as const).map((direction) => {
          const label = direction === "up" ? "Move up" : "Move down";
          const Icon = direction === "up" ? ArrowUpIcon : ArrowDownIcon;
          return (
            <button
              key={direction}
              ref={(element) => moveButtonRef(direction, element)}
              type="button"
              className="notes-btn-quiet notes-task-move-button"
              title={`${label} (Alt+${direction === "up" ? "↑" : "↓"})`}
              aria-label={`${label}: ${taskText}`}
              aria-keyshortcuts={direction === "up" ? "Alt+ArrowUp" : "Alt+ArrowDown"}
              disabled={direction === "up" ? !move.canMoveUp : !move.canMoveDown}
              onKeyDown={onMoveButtonKeyDown(direction)}
              onClick={() => onMove(direction, "arrow")}
            >
              <Icon size={14} weight="bold" aria-hidden="true" />
            </button>
          );
        })}
      <div className="notes-task-menu" ref={rootRef}>
        <button
          ref={(element) => {
            triggerElement.current = element;
            triggerRef(element);
          }}
          type="button"
          className="notes-btn-quiet notes-task-menu-trigger"
          title="Task actions"
          aria-label={`Task actions: ${taskText}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-keyshortcuts={move ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          onKeyDown={onTriggerKeyDown}
          onClick={() => setOpen((current) => !current)}
        >
          <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
        </button>
        {open && (
          <div
            ref={menuRef}
            id={menuId}
            className="winlayout-menu notes-task-menu-list"
            style={{ background: theme.surface2, borderColor: theme.border }}
            role="menu"
            aria-label={`Actions for ${taskText}`}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => (
              <MenuEntry
                key={item.key}
                item={item}
                onSelect={() => {
                  close(false);
                  item.onSelect();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuEntry({ item, onSelect }: { item: MenuItem; onSelect(): void }): React.ReactElement {
  return (
    <>
      {item.separatorBefore && <div className="winlayout-divider" role="separator" />}
      <button
        type="button"
        role="menuitem"
        className={`winlayout-item${item.danger ? " notes-task-menu-danger" : ""}`}
        disabled={item.disabled}
        aria-keyshortcuts={item.shortcut?.aria}
        onClick={onSelect}
      >
        <span>{item.label}</span>
        {item.shortcut && (
          <kbd className="notes-task-menu-hint" aria-hidden="true">
            {item.shortcut.hint}
          </kbd>
        )}
      </button>
    </>
  );
}

function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"));
}
