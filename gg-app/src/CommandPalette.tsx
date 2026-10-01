import { useEffect, useId, useMemo, useState } from "react";
import { SLASH_COMMAND_NAME_MAX_LENGTH } from "@kenkaiiii/gg-core/slash-command-contract";
import { Modal } from "./Modal";
import { theme } from "./theme";
import type { CommandProblem, SlashCommand } from "./agent";
import { commandScope, paletteGroups } from "./menu-commands";

interface Props {
  /** Collection commands to list; every one passed in is shown (missing group → Other). */
  commands: readonly SlashCommand[];
  /** Command files that could not be listed or lost their header settings. */
  problems?: readonly CommandProblem[];
  /** Enter / click: put the command in the chat box. */
  onInsert: (command: SlashCommand) => void;
  /** Shift+Enter: send the command straight away (queued while the agent works). */
  onSend: (command: SlashCommand) => void;
  onClose: () => void;
}

const PROBLEM_TEXT: Readonly<Record<CommandProblem["reason"], string>> = {
  unreadable: "Couldn't be read, so it isn't listed.",
  "malformed-frontmatter": "Its header isn't closed with ---, so its settings were ignored.",
  // Covers both an empty name (a file named just `.md`) and an over-long one.
  "invalid-name": `Its name is empty or longer than ${SLASH_COMMAND_NAME_MAX_LENGTH} characters, so it isn't listed.`,
};

function matches(command: SlashCommand, query: string): boolean {
  if (!query) return true;
  return (
    command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query)
  );
}

/**
 * Ctrl/Cmd+K palette of the commands it is given (the pane passes collection
 * commands), grouped Everyday → Specialist → Setup → Other. Focus stays in the search box; ↑/↓ and Ctrl/Cmd+Home/End move the
 * highlight via `aria-activedescendant`. Escape, Tab containment and focus
 * return belong to the surrounding Modal.
 */
export function CommandPalette({
  commands,
  problems = [],
  onInsert,
  onSend,
  onClose,
}: Props): React.ReactElement {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const problemsId = `${baseId}-problems`;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      paletteGroups(commands)
        .map((group) => ({
          ...group,
          commands: group.commands.filter((command) => matches(command, normalizedQuery)),
        }))
        .filter((group) => group.commands.length > 0),
    [commands, normalizedQuery],
  );
  const options = useMemo(() => groups.flatMap((group) => group.commands), [groups]);
  const active = options.length > 0 ? Math.min(activeIndex, options.length - 1) : -1;
  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const activeId = active >= 0 ? optionId(active) : undefined;

  // Keep the highlighted row visible as it moves.
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    // Don't cut an input-method composition short, or re-handle a claimed key.
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const count = options.length;
    const mod = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (count) setActiveIndex((active + 1) % count);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (count) setActiveIndex((active - 1 + count) % count);
        return;
      case "Home":
        // Plain Home keeps moving the caret inside the search box.
        if (!mod) return;
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        if (!mod) return;
        event.preventDefault();
        if (count) setActiveIndex(count - 1);
        return;
      case "Enter": {
        event.preventDefault();
        const command = options[active];
        if (!command) return;
        if (event.shiftKey) onSend(command);
        else onInsert(command);
        return;
      }
      default:
    }
  }

  let flatIndex = 0;
  return (
    <Modal title="Commands" onClose={onClose} className="command-palette">
      <input
        data-modal-initial-focus
        className="modal-input command-palette-input"
        type="text"
        role="combobox"
        aria-label="Search commands"
        aria-expanded={true}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-describedby={problems.length ? `${hintId} ${problemsId}` : hintId}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Search commands"
        value={query}
        style={{ color: theme.text, background: theme.inputBackground }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {problems.length > 0 && (
        <section
          id={problemsId}
          className="command-palette-problems"
          aria-labelledby={`${problemsId}-title`}
        >
          <h3 id={`${problemsId}-title`} className="command-palette-problems-title">
            {problems.length === 1
              ? "1 command file has a problem"
              : `${problems.length} command files have problems`}
          </h3>
          <ul>
            {problems.map((problem) => (
              <li key={`${problem.scope}:${problem.file}:${problem.reason}`}>
                <span className="command-palette-problem-file">{problem.file}</span>{" "}
                <span className="command-palette-scope">{problem.scope}</span>{" "}
                <span className="command-palette-problem-reason" style={{ color: theme.textMuted }}>
                  {PROBLEM_TEXT[problem.reason]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div id={listId} className="command-palette-list" role="listbox" aria-label="Commands">
        {groups.map((group) => {
          const headingId = `${baseId}-group-${group.key}`;
          return (
            <div key={group.key} role="presentation" className="command-palette-group">
              <div
                id={headingId}
                aria-hidden="true"
                className="command-palette-heading"
                style={{ color: theme.textMuted }}
              >
                {group.label}
              </div>
              <div role="group" aria-labelledby={headingId}>
                {group.commands.map((command) => {
                  const index = flatIndex++;
                  const isActive = index === active;
                  const scope = commandScope(command);
                  return (
                    <div
                      key={`${command.origin ?? command.source}:${command.name}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isActive}
                      className={`slash-item command-palette-option${isActive ? " active" : ""}`}
                      // Keep focus in the search box while clicking a row.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (!isActive) setActiveIndex(index);
                      }}
                      onClick={() => onInsert(command)}
                    >
                      <span className="slash-name" style={{ color: theme.commandColor }}>
                        /{command.name}
                      </span>
                      {command.argumentHint && (
                        <span
                          className="slash-hint"
                          style={{ color: theme.textMuted }}
                          title={command.argumentHint}
                        >
                          {command.argumentHint}
                        </span>
                      )}
                      <span
                        className="slash-desc command-palette-desc"
                        style={{ color: theme.textMuted }}
                      >
                        {command.description}
                      </span>
                      <span className="command-palette-tags">
                        {command.effect && (
                          <span
                            className={`command-palette-effect command-palette-effect-${command.effect}`}
                          >
                            {command.effect}
                          </span>
                        )}
                        <span className="command-palette-scope" style={{ color: theme.textMuted }}>
                          {scope}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {options.length === 0 && (
          <div
            role="presentation"
            className="command-palette-empty"
            style={{ color: theme.textMuted }}
          >
            {commands.length === 0 ? "No collection commands could be loaded." : "No matches"}
          </div>
        )}
      </div>
      <p id={hintId} className="command-palette-keys" style={{ color: theme.textMuted }}>
        Enter puts it in the chat box · Shift+Enter sends it
      </p>
    </Modal>
  );
}
