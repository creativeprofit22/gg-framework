import { setColorSchemePref, useColorSchemePref, type ColorSchemePref } from "./color-scheme";

const OPTIONS: ReadonlyArray<{ value: ColorSchemePref; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

/** Light / Dark / Auto, for every window at once. */
export function AppearancePicker(): React.ReactElement {
  const pref = useColorSchemePref();
  return (
    <div className="key-group" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className="key key-sm"
          role="radio"
          aria-checked={pref === value}
          onClick={() => setColorSchemePref(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
