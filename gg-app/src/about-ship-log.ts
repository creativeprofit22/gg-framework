import type { ChangelogEntry } from "./changelog";
import { splitItem } from "./whatsnew-content";

/**
 * The About page's ship log: every day from GG Coder's first release to today,
 * laid out as a calendar (a column per week, Monday at the top) and lit by how
 * many releases shipped that day. Built from the real changelog, so every
 * number on the page can be checked against it.
 *
 * Dates are ISO `YYYY-MM-DD` strings handled as UTC calendar days, so the
 * result never depends on the machine's time zone. `today` is passed in.
 */

/** 0 is a day with nothing shipped; 4 is four releases or more. */
export type ShipLevel = 0 | 1 | 2 | 3 | 4;

export interface ShipDay {
  /** ISO date. */
  readonly date: string;
  /** That day's releases, newest first (the changelog's order). */
  readonly releases: readonly ChangelogEntry[];
  readonly level: ShipLevel;
  /** Week column, from 0. */
  readonly week: number;
  /** Day of the week, Monday 0 to Sunday 6. */
  readonly weekday: number;
}

export interface ShipLog {
  /** Every day from the first release to the end, oldest first. */
  readonly days: readonly ShipDay[];
  readonly weeks: number;
  /** A label for each week column a month starts in. */
  readonly months: readonly { readonly label: string; readonly week: number }[];
  readonly firstDate: string;
  readonly releases: number;
  readonly features: number;
  /** Days with at least one release. */
  readonly shippingDays: number;
  /** The day with the most releases (the latest, on a tie). */
  readonly busiest: ShipDay | null;
  /** The latest day anything shipped. */
  readonly lastShipped: ShipDay | null;
}

const DAY_MS = 86_400_000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function toMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday 0 to Sunday 6. */
function weekdayOf(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

function levelFor(count: number): ShipLevel {
  if (count >= 4) return 4;
  if (count === 3) return 3;
  if (count === 2) return 2;
  return count === 1 ? 1 : 0;
}

export function buildShipLog(changelog: readonly ChangelogEntry[], today: string): ShipLog {
  const byDate = new Map<string, ChangelogEntry[]>();
  for (const entry of changelog) {
    const list = byDate.get(entry.date);
    if (list) list.push(entry);
    else byDate.set(entry.date, [entry]);
  }
  const dates = [...byDate.keys()].sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const features = changelog.reduce((sum, entry) => sum + entry.items.length, 0);
  if (!firstDate || !lastDate) {
    return {
      days: [],
      weeks: 0,
      months: [],
      firstDate: today,
      releases: 0,
      features,
      shippingDays: 0,
      busiest: null,
      lastShipped: null,
    };
  }

  const start = toMs(firstDate);
  const end = Math.max(toMs(lastDate), toMs(today));
  const lead = weekdayOf(start);
  const days: ShipDay[] = [];
  const months: { label: string; week: number }[] = [];
  let busiest: ShipDay | null = null;
  let lastShipped: ShipDay | null = null;
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const date = toIso(ms);
    const releases = byDate.get(date) ?? [];
    const index = lead + days.length;
    const day: ShipDay = {
      date,
      releases,
      level: levelFor(releases.length),
      week: Math.floor(index / 7),
      weekday: index % 7,
    };
    days.push(day);
    const dayOfMonth = new Date(ms).getUTCDate();
    if (days.length === 1 || dayOfMonth === 1) {
      const label = MONTHS[new Date(ms).getUTCMonth()] ?? "";
      const previous = months[months.length - 1];
      // A month starting in the first one's column takes the label over.
      if (previous && previous.week === day.week) previous.label = label;
      else months.push({ label, week: day.week });
    }
    if (releases.length > 0) {
      lastShipped = day;
      if (!busiest || releases.length >= busiest.releases.length) busiest = day;
    }
  }
  const lastDay = days[days.length - 1];
  return {
    days,
    weeks: lastDay ? lastDay.week + 1 : 0,
    months,
    firstDate,
    releases: changelog.length,
    features,
    shippingDays: byDate.size,
    busiest,
    lastShipped,
  };
}

/** "Tue 14 Oct". */
export function formatShipDate(iso: string): string {
  const ms = toMs(iso);
  const date = new Date(ms);
  return `${WEEKDAYS[weekdayOf(ms)] ?? ""} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "March 2026". */
export function formatMonthYear(iso: string): string {
  const date = new Date(toMs(iso));
  return `${MONTH_NAMES[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}

/** "4 Mar 2026". */
export function formatLongDate(iso: string): string {
  const date = new Date(toMs(iso));
  return `${formatShortDate(iso)} ${date.getUTCFullYear()}`;
}

/** "14 Jun". */
export function formatShortDate(iso: string): string {
  const date = new Date(toMs(iso));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** The day a version shipped, if it's in the log. */
export function dayOfVersion(log: ShipLog, version: string | null): ShipDay | null {
  if (!version) return null;
  return log.days.find((day) => day.releases.some((r) => r.version === version)) ?? null;
}

/** "v0.90.1", "v0.90.0 and v0.90.1", "v0.88.0 to v0.88.7". */
export function versionsLabel(day: ShipDay): string {
  const newest = day.releases[0];
  const oldest = day.releases[day.releases.length - 1];
  if (!newest || !oldest) return "";
  if (day.releases.length === 1) return `v${newest.version}`;
  const joiner = day.releases.length === 2 ? "and" : "to";
  return `v${oldest.version} ${joiner} v${newest.version}`;
}

/** The newest release's lead feature, as its hook sentence, plus how many more. */
export function dayHeadline(day: ShipDay): { headline: string; more: number } | null {
  const lead = day.releases[0]?.items[0];
  if (!lead) return null;
  const total = day.releases.reduce((sum, r) => sum + r.items.length, 0);
  return { headline: splitItem(lead).headline, more: total - 1 };
}

/** The user's local calendar date, as ISO. */
export function localIsoDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
