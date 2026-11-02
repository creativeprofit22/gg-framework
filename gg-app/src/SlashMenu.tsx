import { useEffect, useRef } from "react";
import { theme } from "./theme";
import type { SlashCommand } from "./agent";
import { useScrollEdges } from "./popover";
import { slashOptionId } from "./slash-menu-keys";

interface Props {
  /** Listbox id the input points at via aria-controls. */
  id: string;
  commands: readonly SlashCommand[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/**
 * Upward command palette anchored to the chat input. Lists "plays" — the slash
 * commands matching the current `/prefix` — with name + description. Keyboard
 * nav (↑/↓/Enter/Esc) lives in the input's onKeyDown; this is presentational.
 */
export function SlashMenu({
  id,
  commands,
  activeIndex,
  onSelect,
  onHover,
}: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  // Keep the active row scrolled into view as the selection moves.
  useEffect(() => {
    // Look up by this menu's option id: split panes can each have a menu open.
    document.getElementById(slashOptionId(id, activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div id={`${id}-title`} className="slash-menu-title" style={{ color: theme.textMuted }}>
        plays
      </div>
      <div
        ref={scrollRef}
        id={id}
        role="listbox"
        aria-labelledby={`${id}-title`}
        className="pop-scroll slash-scroll"
        onScroll={onScroll}
      >
        {commands.map((cmd, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={cmd.name}
              type="button"
              id={slashOptionId(id, i)}
              role="option"
              aria-selected={active}
              tabIndex={-1}
              data-idx={i}
              className={`slash-item${active ? " active" : ""}`}
              // Keep focus (and the caret) in the composer while clicking a row.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(cmd)}
            >
              <span className="slash-name" style={{ color: theme.commandColor }}>
                /{cmd.name}
              </span>
              {active && cmd.argumentHint && (
                <span
                  className="slash-hint"
                  style={{ color: theme.textMuted }}
                  title={cmd.argumentHint}
                >
                  {cmd.argumentHint}
                </span>
              )}
              <span className="slash-desc" style={{ color: theme.textMuted }}>
                {cmd.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
