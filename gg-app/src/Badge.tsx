/**
 * Small badge with a consistent shape across the app: an Alloy well. Neutral
 * by default (colour is reserved as a data signal). Pass `color` where the hue
 * *is* the indicator (a session's source): it lights a small dot before the
 * label, and the label keeps neutral ink so it reads on both themes.
 */
export function Badge({
  children,
  color,
  title,
  className,
}: {
  children: React.ReactNode;
  color?: string;
  /** Extra class, for callers that style or find a particular badge. */
  className?: string;
  /** Native tooltip, for badges whose colour carries state worth spelling out. */
  title?: string;
}): React.ReactElement {
  return (
    <span className={className ? `badge ${className}` : "badge"} title={title}>
      {color && <i className="badge-dot" style={{ background: color }} aria-hidden="true" />}
      {children}
    </span>
  );
}
