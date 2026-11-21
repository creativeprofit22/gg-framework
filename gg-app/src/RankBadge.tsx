import type { ProgressSnapshot } from "./agent";

interface RankBadgeProps {
  snapshot: ProgressSnapshot | null;
  onClick: () => void;
  className?: string;
  /** Changes on rank-up to replay the subtle badge celebration. */
  celebrateNonce?: string | null;
}

export function RankBadge({
  snapshot,
  onClick,
  className,
  celebrateNonce,
}: RankBadgeProps): React.ReactElement | null {
  if (!snapshot) return null;
  const atMaxLevel = snapshot.maxLevel !== undefined && snapshot.level >= snapshot.maxLevel;
  // Legacy producers do not identify their cap; never guess from a denominator sentinel.
  const progress =
    snapshot.maxLevel === undefined || atMaxLevel
      ? `${atMaxLevel ? "Maximum level · " : ""}${new Intl.NumberFormat().format(snapshot.xp)} lifetime XP`
      : `${snapshot.xpIntoLevel}/${snapshot.xpForLevel} XP to next`;
  const title = `${snapshot.rankName} — Level ${snapshot.level} · ${progress}`;
  const cls = className ? `rank-badge ${className}` : "rank-badge";
  return (
    <button
      className={`${cls}${celebrateNonce ? " rank-badge-celebrate" : ""}`}
      type="button"
      title={title}
      onClick={onClick}
    >
      <span className="rank-glyph" aria-hidden="true" />
      <span className="rank-level" key={celebrateNonce ? `${celebrateNonce}-level` : "level"}>
        {snapshot.level}
      </span>
      <span
        className={`rank-name rank-fx-${snapshot.effectId}`}
        key={celebrateNonce ? `${celebrateNonce}-name` : "name"}
      >
        {snapshot.rankName}
      </span>
      {celebrateNonce && <span className="rank-sparks" aria-hidden="true" />}
    </button>
  );
}
