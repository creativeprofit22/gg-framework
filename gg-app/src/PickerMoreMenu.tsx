import { useEffect, useId, useRef, useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { theme } from "./theme";

export interface PickerMoreItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  items: readonly PickerMoreItem[];
  /** Disables the trigger and every item while an action is running. */
  disabled?: boolean;
  label?: string;
}

/**
 * Overflow "More" menu for the narrow picker header. Same interaction model as
 * the WindowLayoutButton menu: Escape and outside-click close it, arrows/Home/End
 * move focus, and focus returns to the trigger.
 */
export function PickerMoreMenu({
  items,
  disabled = false,
  label = "More actions",
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const listenerId = window.setTimeout(
      () => document.addEventListener("mousedown", closeOnOutsideClick),
      0,
    );
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(),
    );
    return () => {
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Close if an action starts elsewhere while the menu is open.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function run(item: PickerMoreItem): void {
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect();
  }

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    if (menuItems.length === 0) return;
    const current = menuItems.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? menuItems.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
    menuItems[next]?.focus();
  }

  return (
    <div className="winlayout picker-more" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-sm btn-nav-icon"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((current) => !current)}
      >
        <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            id={menuId}
            className="winlayout-menu"
            role="menu"
            aria-label={label}
            onKeyDown={moveMenuFocus}
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="winlayout-item"
                disabled={disabled}
                onClick={() => run(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
