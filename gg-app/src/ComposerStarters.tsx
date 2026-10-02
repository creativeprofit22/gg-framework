import { theme } from "./theme";

export type ComposerStarter = Readonly<{ label: string; prompt: string }>;

/**
 * A row of starting points for an empty conversation. Picking one hands its
 * prompt to `onPick` (which fills the composer); it never submits anything.
 */
export function ComposerStarters({
  starters,
  label,
  onPick,
}: {
  starters: readonly ComposerStarter[];
  label: string;
  onPick: (prompt: string) => void;
}): React.ReactElement {
  return (
    <div className="motion-starters" role="group" aria-label={label}>
      {starters.map((starter) => (
        <button
          key={starter.label}
          type="button"
          className="btn btn-sm btn-ghost motion-starter"
          style={{ color: theme.text }}
          onClick={() => onPick(starter.prompt)}
        >
          {starter.label}
        </button>
      ))}
    </div>
  );
}
