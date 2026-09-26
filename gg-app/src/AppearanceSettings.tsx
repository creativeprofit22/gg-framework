import { useId, useSyncExternalStore } from "react";
import { appearance, type Appearance } from "./appearance";

const controls: {
  field: keyof Appearance;
  label: string;
  description: string;
  options: readonly (readonly [string, string])[];
}[] = [
  {
    field: "theme",
    label: "Theme",
    description: "Dark is the default. Light keeps the same workspace and controls.",
    options: [
      ["dark", "Dark"],
      ["light", "Light"],
    ],
  },
  {
    field: "size",
    label: "Prose size",
    description: "Message text only. Code and compact controls keep their size.",
    options: [
      ["15", "15 px (default)"],
      ["16", "16 px"],
    ],
  },
  {
    field: "tracking",
    label: "Letter spacing",
    description: "Keep the current spacing or use normal spacing in messages.",
    options: [
      ["current", "Current"],
      ["normal", "Normal"],
    ],
  },
  {
    field: "paragraphs",
    label: "Paragraph spacing",
    description: "Space between paragraphs in replies.",
    options: [
      ["current", "Current"],
      ["roomy", "Roomier"],
    ],
  },
  {
    field: "cap",
    label: "Wide-pane reading width",
    description: "Limit prose width only in panes at least 900 px wide.",
    options: [
      ["off", "Full width"],
      ["on", "Limit reading width"],
    ],
  },
  {
    field: "markers",
    label: "Identity markers",
    description: "Small shapes distinguish you, the assistant and Ken.",
    options: [
      ["off", "Current"],
      ["on", "Show markers"],
    ],
  },
  {
    field: "streaming",
    label: "Streamed words",
    description: "Keep the current reveal or show each word without the reveal effect.",
    options: [
      ["current", "Current reveal"],
      ["crisp", "Crisp reveal"],
    ],
  },
];

export function AppearanceSettings(): React.ReactElement {
  const id = useId();
  const { preferences, persistenceWarning } = useSyncExternalStore(
    appearance.subscribe,
    appearance.getSnapshot,
  );
  return (
    <section className="appearance-settings" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="modal-label">
        Appearance and reading
      </h3>
      <p className="modal-hint">
        Changes apply immediately in both themes and save separately from the project folder. Cancel
        does not undo them.
      </p>
      <div className="appearance-controls">
        {controls.map(({ field, label, description, options }) => (
          <div className="appearance-control" key={field}>
            <div>
              <label htmlFor={`${id}-${field}`}>{label}</label>
              <p id={`${id}-${field}-hint`} className="modal-hint">
                {description}
              </p>
            </div>
            <select
              id={`${id}-${field}`}
              value={preferences[field]}
              aria-describedby={`${id}-${field}-hint`}
              onChange={(event) => appearance.update({ [field]: event.target.value })}
            >
              {options.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {persistenceWarning && (
        <p className="appearance-warning" role="status">
          {persistenceWarning}
        </p>
      )}
      <button type="button" className="modal-btn" onClick={appearance.reset}>
        Reset appearance defaults
      </button>
    </section>
  );
}
