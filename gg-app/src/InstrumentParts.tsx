import type { ReactNode } from "react";

/** Lamp colours map to existing status tokens in Instrument.css. */
export type LampTone = "primary" | "success" | "warning" | "neutral";

/** Decorative status light. Meaning is always carried by the text beside it. */
export function StatusLamp({ tone }: { tone: LampTone }): React.ReactElement {
  return <span className="inst-lamp" data-tone={tone} aria-hidden="true" />;
}

/** Small engraved label plate: short mono capitals naming a kind or state. */
export function DataPlate({ children }: { children: ReactNode }): React.ReactElement {
  return <span className="inst-plate">{children}</span>;
}

export interface SpecRow {
  /** Stable React key when two rows could share a term. */
  id?: string;
  term: string;
  value: ReactNode;
}

/** Key/value readout. Terms render as mono capitals; values stay plain sentences. */
export function SpecList({
  rows,
  label,
}: {
  rows: readonly SpecRow[];
  label?: string;
}): React.ReactElement {
  return (
    <dl className="inst-spec" aria-label={label}>
      {rows.map((row) => (
        <div className="inst-spec-row" key={row.id ?? row.term}>
          <dt>{row.term}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
