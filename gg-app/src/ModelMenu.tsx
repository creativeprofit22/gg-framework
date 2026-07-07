import { useEffect, useRef } from "react";
import { PRODUCT_DISPLAY_NAME, MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import type { ModelOption } from "./agent";

interface Props {
  models: readonly ModelOption[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  /** Menu heading (defaults to "select model"). */
  title?: string;
  /** When set, renders a "Follow GG Coder" row above the model grid (Ken's
   *  picker) — selecting it clears the pin. `followActive` highlights it when
   *  no pin is set. */
  onSelectFollow?: () => void;
  followActive?: boolean;
}

/**
 * Upward-opening model picker anchored to the footer. Shows just the model
 * names in a multi-column grid (there are many models), with the active one
 * highlighted. Closes on outside-click or Escape.
 */
export function ModelMenu({
  models,
  currentModel,
  onSelect,
  onClose,
  title,
  onSelectFollow,
  followActive,
}: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="model-menu"
      ref={ref}
      style={{ background: theme.surface2, borderColor: theme.border }}
    >
      <div className="model-menu-title" style={{ color: theme.textMuted }}>
        {title ?? "select model"}
      </div>
      {onSelectFollow && (
        <button
          className={`model-menu-item model-menu-follow${followActive ? " active" : ""}`}
          style={{
            color: followActive ? theme.primary : theme.text,
            background: followActive ? theme.surface2 : "transparent",
          }}
          onClick={onSelectFollow}
          title={`${MENTOR_DISPLAY_NAME} adopts whatever model ${PRODUCT_DISPLAY_NAME} is using`}
        >
          Follow {PRODUCT_DISPLAY_NAME}
        </button>
      )}
      <div className="model-menu-grid">
        {models.map((m) => {
          // With a follow row present (Ken's picker), a model is only "active"
          // when it's an explicit pin — not when Ken merely inherits it.
          const active = m.id === currentModel && !(onSelectFollow && followActive);
          return (
            <button
              key={`${m.provider}:${m.id}`}
              className={`model-menu-item${active ? " active" : ""}`}
              style={{
                color: active ? theme.primary : theme.text,
                background: active ? theme.surface2 : "transparent",
              }}
              onClick={() => onSelect(m.id)}
              title={`${m.provider} · ${m.id}`}
            >
              {m.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
