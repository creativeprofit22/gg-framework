import { useState } from "react";
import type { Trophy, TrophySnapshot, TrophyTier } from "./agent";
import { PanelHead } from "./DeckPanelHead";

type TrophyTab = "earned" | "locked";

export const TIER_NAME: Readonly<Record<TrophyTier, string>> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
};

const DATE = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** The cup, filled, for medals (the rail key uses the outlined Iconoir glyph). */
export function TrophyMedal({
  tier,
  locked = false,
  shine = false,
  className = "trophy-medal",
}: {
  tier: TrophyTier;
  locked?: boolean;
  /** A light sweep layer the unlock card animates across the medal. */
  shine?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={className}
      data-tier={tier}
      data-locked={locked || undefined}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M7 4h10v4.5a5 5 0 0 1-10 0V4z" fill="currentColor" />
        <path
          d="M7 6H4.6a2.6 2.6 0 0 0 2.9 4.1M17 6h2.4a2.6 2.6 0 0 1-2.9 4.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="M12 13.5V17" stroke="currentColor" strokeWidth="2" />
        <rect x="8" y="17" width="8" height="3.2" rx="1" fill="currentColor" />
      </svg>
      {shine && <span className="tu-shine" />}
    </span>
  );
}

/**
 * The trophy case (the trophies key): every trophy, earned or still to earn,
 * one tab each, grouped by area of the app in the catalog's order, which runs
 * from first steps to long-haul challenges. A locked trophy says what it is
 * and how to earn it, so the case doubles as a tour of what GG Coder can do.
 */
export function TrophiesPanel({
  snapshot,
  onClose,
}: {
  snapshot: TrophySnapshot | null;
  onClose: () => void;
}): React.ReactElement {
  const earnedCount = snapshot?.earned ?? 0;
  // A first look with nothing earned yet opens on what there is to earn.
  const [tab, setTab] = useState<TrophyTab>(earnedCount > 0 ? "earned" : "locked");
  const list = (snapshot?.trophies ?? []).filter((t) =>
    tab === "earned" ? t.unlockedAt !== null : t.unlockedAt === null,
  );
  const counts: Record<TrophyTab, number> = {
    earned: earnedCount,
    locked: (snapshot?.total ?? 0) - earnedCount,
  };
  const tabs: ReadonlyArray<{ id: TrophyTab; label: string }> = [
    { id: "earned", label: "Earned" },
    { id: "locked", label: "To earn" },
  ];

  return (
    <div className="deck-panel tool-panel trophies-panel">
      <PanelHead
        title="Trophies"
        meta={snapshot ? `${snapshot.earned} of ${snapshot.total} earned` : undefined}
        onClose={onClose}
      />
      <div className="deck-prow git-tabs">
        <div className="key-group goal-view-switch" role="tablist" aria-label="Trophies">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`trophy-tab-${id}`}
              aria-controls="trophy-tabpanel"
              className="key key-sm"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
              {snapshot && <span className="tab-n">{counts[id]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div
        className="tool-body trophies-body"
        id="trophy-tabpanel"
        role="tabpanel"
        aria-labelledby={`trophy-tab-${tab}`}
        tabIndex={-1}
      >
        {!snapshot ? (
          <p className="deck-note">Loading&hellip;</p>
        ) : list.length === 0 ? (
          <p className="deck-note">
            {tab === "earned"
              ? "No trophies yet. Open To earn to see how to get your first."
              : "Every trophy is yours. Nothing left to earn."}
          </p>
        ) : (
          snapshot.categories.map((category) => {
            const items = list.filter((t) => t.category === category.id);
            if (items.length === 0) return null;
            return (
              <section
                key={category.id}
                className="trophy-group"
                aria-labelledby={`tg-${category.id}`}
              >
                <h3 className="trophy-group-title" id={`tg-${category.id}`}>
                  {category.label}
                </h3>
                <ul className="trophy-list">
                  {items.map((t) => (
                    <TrophyRow key={t.id} trophy={t} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function TrophyRow({ trophy: t }: { trophy: Trophy }): React.ReactElement {
  const earned = t.unlockedAt !== null;
  const pct = t.goal > 0 ? Math.round((t.current / t.goal) * 100) : 0;
  return (
    <li className="trophy-row" data-earned={earned || undefined}>
      <TrophyMedal tier={t.tier} locked={!earned} />
      <div className="trophy-main">
        <div className="trophy-head">
          <span className="trophy-title">{t.title}</span>
          <span className="trophy-tier">
            <span className="tier-dot" data-tier={t.tier} aria-hidden="true" />
            {TIER_NAME[t.tier]}
          </span>
        </div>
        {t.description && <p className="trophy-desc">{t.description}</p>}
        {earned ? (
          <p className="trophy-meta">Earned {DATE.format(new Date(t.unlockedAt ?? ""))}</p>
        ) : (
          <>
            <p className="trophy-hint">
              <span className="trophy-how">How:</span> {t.hint}
            </p>
            {t.goal > 1 && (
              <div className="trophy-progress">
                <span
                  className="sc-bar"
                  data-tier={t.tier}
                  role="progressbar"
                  aria-label={`${t.title} progress`}
                  aria-valuemin={0}
                  aria-valuemax={t.goal}
                  aria-valuenow={t.current}
                  style={{ "--p": pct } as React.CSSProperties}
                />
                <span className="trophy-count">
                  {t.current.toLocaleString()} of {t.goal.toLocaleString()}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}
