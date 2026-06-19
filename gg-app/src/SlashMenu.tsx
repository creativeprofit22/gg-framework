import { useEffect } from "react";
import { theme } from "./theme";
import type { SlashCommand } from "./agent";

interface Props {
  commands: readonly SlashCommand[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/**
 * Upward command palette anchored to the chat input. Lists slash commands
 * matching the current `/prefix`, with name + description. Keyboard nav
 * (↑/↓/Enter/Esc) lives in the input's onKeyDown; this is presentational.
 */
function sectionTitle(command: SlashCommand): string {
  if (command.source === "workflow") return "workflows";
  if (command.source === "custom") return "custom";
  return "built-in";
}

export function SlashMenu({ commands, activeIndex, onSelect, onHover }: Props): React.ReactElement {
  // Keep the active row scrolled into view as the selection moves.
  useEffect(() => {
    document
      .querySelector(`.slash-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        commands
      </div>
      {commands.map((cmd, i) => {
        const active = i === activeIndex;
        const currentSection = sectionTitle(cmd);
        const previousCommand = i > 0 ? commands[i - 1] : undefined;
        const previous = previousCommand ? sectionTitle(previousCommand) : null;
        const showSection = currentSection !== previous;
        return (
          <div key={cmd.name}>
            {showSection ? (
              <div className="slash-section" style={{ color: theme.textDim }}>
                -- {currentSection} --
              </div>
            ) : null}
            <button
              data-idx={i}
              className={`slash-item${active ? " active" : ""}`}
              style={{ background: active ? theme.surface1 : "transparent" }}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(cmd)}
            >
              <span className="slash-name" style={{ color: theme.commandColor }}>
                /{cmd.name}
              </span>
              <span className="slash-desc" style={{ color: theme.textMuted }}>
                {cmd.description}
              </span>
              {cmd.scope === "project" ? (
                <span
                  className="slash-scope"
                  style={{ color: theme.secondary, borderColor: theme.border }}
                >
                  project
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
