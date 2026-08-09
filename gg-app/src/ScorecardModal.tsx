import { Modal } from "./Modal";
import type { ProgressSnapshot } from "./agent";

interface ScorecardModalProps {
  snapshot: ProgressSnapshot;
  onClose: () => void;
}

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

interface StatRow {
  label: string;
  value: string;
  goal: string;
  percent: number;
  title: string;
}

/** Build one stat row against its milestone band. `suffix` labels the unit (e.g. "d"). */
function statRow(label: string, value: number, ladder: number[] | number, suffix = ""): StatRow {
  const { next, percent } = milestoneFor(value, ladder);
  const remaining = next - value;
  return {
    label,
    value: `${fmt(value)}${suffix}`,
    goal: `${fmtCompact(next)}${suffix}`,
    percent,
    title: `${label}: ${fmt(value)}${suffix} — ${fmt(remaining)}${suffix} to ${fmt(next)}${suffix} (${percent}%)`,
  };
}

/** RPG character-card scorecard: rank header, level + XP bar, stat bars. */
export function ScorecardModal({ snapshot, onClose }: ScorecardModalProps): React.ReactElement {
  const stats: StatRow[] = [
    statRow("Streak", snapshot.streak.current, STREAK_MILESTONES, "d"),
    statRow("Prompts", snapshot.totals.prompts, 100),
    statRow("Commits", snapshot.totals.commits, 10),
    statRow("Lines shipped", snapshot.totals.linesShipped, 1000),
  ];
  return (
    <Modal
      title={
        <span className={`scorecard-rank rank-fx-${snapshot.effectId}`}>{snapshot.rankName}</span>
      }
      onClose={onClose}
      className="scorecard-modal"
    >
      <div className="scorecard">
        <div className="scorecard-tier">{snapshot.tierName} tier</div>

        <div className="scorecard-level">
          <span className="scorecard-level-num">{snapshot.level}</span>
          <div className="scorecard-level-meter">
            <div className="scorecard-level-row">
              <span>Level</span>
              <span>
                {fmt(snapshot.xpIntoLevel)} / {fmt(snapshot.xpForLevel)} XP · {snapshot.percent}%
              </span>
            </div>
            <div className="scorecard-bar" aria-hidden="true">
              <span style={{ width: `${snapshot.percent}%` }} />
            </div>
          </div>
        </div>

        <div className="scorecard-divider" aria-hidden="true" />

        <div className="scorecard-stats">
          {stats.map((stat) => (
            <div className="scorecard-stat" key={stat.label}>
              <span className="scorecard-stat-label" title={stat.title}>
                {stat.label}
              </span>
              <div className="scorecard-stat-bar" title={stat.title}>
                <span style={{ width: `${stat.percent}%` }} />
              </div>
              <b title={stat.title}>
                {stat.value}
                <i className="scorecard-stat-goal">/ {stat.goal}</i>
              </b>
            </div>
          ))}
        </div>

        <div className="scorecard-footer">
          <span>Member since</span>
          <b>{dateLabel(snapshot.memberSince)}</b>
        </div>
      </div>
    </Modal>
  );
}
