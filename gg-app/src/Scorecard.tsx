import type { ProgressSnapshot } from "./agent";

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** Short form for goal labels: 1K, 50K, 2.5M. */
function fmtCompact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
    .format(n)
    .toUpperCase();
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Stat bars track the NEXT milestone, not a lifetime ceiling.
 *
 * A fixed soft-max is a losing game: pick it low and heavy users peg at 100%
 * forever, pick it high and the log curve makes the bar crawl so slowly it reads
 * as frozen. A milestone band does both jobs — it empties every time you clear a
 * goal, so the bar always has somewhere to go and always moves at a visible pace.
 */
export interface Milestone {
  /** Milestone already cleared — the bar's 0% point. */
  prev: number;
  /** Milestone being chased — the bar's 100% point. */
  next: number;
  percent: number;
}

/** Round, human milestones: 1 → 2 → 5 → 10 → 20 → 50 → … scaled from `base`. */
function stepMilestone(value: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const mantissa = Math.round(value / magnitude);
  if (mantissa < 2) return 2 * magnitude;
  if (mantissa < 5) return 5 * magnitude;
  return 10 * magnitude;
}

/** Streak goals follow the calendar rather than powers of ten. */
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365, 730, 1095];

export function milestoneFor(value: number, ladder: number[] | number): Milestone {
  let prev = 0;
  let next: number;

  if (Array.isArray(ladder)) {
    next = ladder.find((m) => m > value) ?? 0;
    if (next === 0) {
      // Past the fixed ladder — keep going in whole years.
      const last = ladder[ladder.length - 1];
      const years = Math.floor((value - last) / 365) + 1;
      prev = last + (years - 1) * 365;
      next = last + years * 365;
    } else {
      prev = [...ladder].reverse().find((m) => m <= value) ?? 0;
    }
  } else {
    next = ladder;
    while (next <= value) {
      prev = next;
      next = stepMilestone(next);
    }
  }

  const span = Math.max(1, next - prev);
  const into = Math.max(0, value - prev);
  return { prev, next, percent: Math.max(2, Math.min(100, Math.round((into / span) * 100))) };
}

interface StatTile {
  label: string;
  /** The big number, in full. */
  value: string;
  /** The milestone being chased, short ("50K", "30d"). */
  goal: string;
  /** What's left to it, in words ("18,392 to go"). */
  left: string;
  percent: number;
  /** A second fact under the bar (the best streak). */
  note?: string;
}

/** Build one stat tile against its milestone band. `suffix` labels the unit ("d"). */
function statTile(
  label: string,
  value: number,
  ladder: number[] | number,
  suffix = "",
  note?: string,
): StatTile {
  const { next, percent } = milestoneFor(value, ladder);
  return {
    label,
    value: `${fmt(value)}${suffix}`,
    goal: `${fmtCompact(next)}${suffix}`,
    left: `${fmt(next - value)}${suffix} to go`,
    percent,
    ...(note ? { note } : {}),
  };
}

/** The next differently-named rank above `level`, from the ladder, if any. */
export function nextRank(
  snapshot: Pick<ProgressSnapshot, "level" | "rankName" | "ladder">,
): ProgressSnapshot["ladder"][number] | null {
  return (
    snapshot.ladder.find(
      (rung) => rung.level > snapshot.level && rung.name !== snapshot.rankName,
    ) ?? null
  );
}

/**
 * Your scorecard as a deck tool (it takes the message box's place, like
 * Notes). A character card: the level in a well beside the rank name in its
 * rank's colours, the XP bar to the next level and the next rank to chase,
 * then a tile per stat, each with its milestone bar and what's left to it.
 */
export function ScorecardPanel({ snapshot }: { snapshot: ProgressSnapshot }): React.ReactElement {
  const tiles: StatTile[] = [
    statTile(
      "Streak",
      snapshot.streak.current,
      STREAK_MILESTONES,
      "d",
      snapshot.streak.best > snapshot.streak.current
        ? `Best ${fmt(snapshot.streak.best)}d`
        : "Your best",
    ),
    statTile("Prompts", snapshot.totals.prompts, 100),
    statTile("Commits", snapshot.totals.commits, 10),
    statTile("Lines shipped", snapshot.totals.linesShipped, 1000),
  ];
  const upcoming = nextRank(snapshot);
  const toNext = snapshot.xpForLevel - snapshot.xpIntoLevel;
  return (
    <div className="scorecard" data-effect={snapshot.effectId}>
      <section className="sc-hero" aria-label="Rank">
        <div className="sc-level" aria-label={`Level ${snapshot.level}`}>
          <span className="sc-level-k" aria-hidden="true">
            Level
          </span>
          <span className="sc-level-n">{snapshot.level}</span>
        </div>
        <div className="sc-id">
          <h3 className={`sc-rank rank-fx-${snapshot.effectId}`}>{snapshot.rankName}</h3>
          <p className="sc-tier">
            <span className="sc-glyph" aria-hidden="true">
              {snapshot.tierGlyph}
            </span>
            {snapshot.tierName} tier
          </p>
        </div>
        <div className="sc-xp">
          <div className="sc-xp-row">
            <span className="sc-xp-k">To level {snapshot.level + 1}</span>
            <span className="sc-xp-v">
              {fmt(snapshot.xpIntoLevel)}
              <span className="sc-of"> / {fmt(snapshot.xpForLevel)} XP</span>
            </span>
          </div>
          <span
            className="sc-bar sc-bar-xp"
            role="meter"
            aria-label={`Level ${snapshot.level} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={snapshot.percent}
            aria-valuetext={`${fmt(toNext)} XP to level ${snapshot.level + 1}`}
            style={{ "--p": snapshot.percent } as React.CSSProperties}
          />
          <p className="sc-xp-note">
            {fmt(toNext)} XP to go
            {upcoming && (
              <>
                {" \u00b7 next rank "}
                <span className={`sc-next rank-fx-${upcoming.effectId}`}>{upcoming.name}</span>
                {` at level ${upcoming.level}`}
              </>
            )}
          </p>
        </div>
      </section>

      <ul className="sc-tiles" aria-label="Stats">
        {tiles.map((tile) => (
          <li key={tile.label} className="sc-tile">
            <span className="sc-tile-k">{tile.label}</span>
            <span className="sc-tile-v">{tile.value}</span>
            <span
              className="sc-bar"
              role="meter"
              aria-label={`${tile.label} toward ${tile.goal}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={tile.percent}
              aria-valuetext={`${tile.value} of ${tile.goal}, ${tile.left}`}
              style={{ "--p": tile.percent } as React.CSSProperties}
            />
            <span className="sc-tile-goal">
              <span>{tile.left}</span>
              <span className="sc-of">{tile.goal}</span>
            </span>
            {tile.note && <span className="sc-tile-note">{tile.note}</span>}
          </li>
        ))}
      </ul>

      <footer className="sc-foot">
        <span>Member since {dateLabel(snapshot.memberSince)}</span>
        <span>{fmt(snapshot.xp)} XP earned</span>
        {snapshot.totals.projects > 0 && (
          <span>
            {fmt(snapshot.totals.projects)}{" "}
            {snapshot.totals.projects === 1 ? "project" : "projects"}
          </span>
        )}
      </footer>
    </div>
  );
}
