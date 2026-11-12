import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog";
import { CHANGELOG } from "./changelog";
import {
  buildShipLog,
  dayHeadline,
  dayOfVersion,
  formatLongDate,
  formatShipDate,
  localIsoDate,
  versionsLabel,
} from "./about-ship-log";

function release(version: string, date: string, items = [`Shipped ${version}. More words.`]) {
  return { version, date, items } satisfies ChangelogEntry;
}

// Newest first, as the changelog is. 2026-06-14 is a Sunday.
const LOG: ChangelogEntry[] = [
  release("0.3.0", "2026-07-02", ["`Goals` got faster. And more.", "Second thing."]),
  release("0.2.1", "2026-06-16"),
  release("0.2.0", "2026-06-16"),
  release("0.1.0", "2026-06-14"),
];

describe("buildShipLog", () => {
  it("lays out every day from the first release to today, Monday on top", () => {
    const log = buildShipLog(LOG, "2026-07-05");

    expect(log.days).toHaveLength(22);
    expect(log.days[0]).toMatchObject({ date: "2026-06-14", week: 0, weekday: 6 });
    // Monday the 15th starts the second column.
    expect(log.days[1]).toMatchObject({ date: "2026-06-15", week: 1, weekday: 0 });
    expect(log.days[21]?.date).toBe("2026-07-05");
    expect(log.weeks).toBe(4);
  });

  it("counts releases, features and shipping days from the changelog", () => {
    const log = buildShipLog(LOG, "2026-07-05");

    expect(log.releases).toBe(4);
    expect(log.features).toBe(5);
    expect(log.shippingDays).toBe(3);
    expect(log.firstDate).toBe("2026-06-14");
    expect(log.busiest?.date).toBe("2026-06-16");
    expect(log.lastShipped?.date).toBe("2026-07-02");
  });

  it("lights a day by how many releases it had, keeping their order", () => {
    const log = buildShipLog(LOG, "2026-07-05");
    const day = log.days.find((d) => d.date === "2026-06-16");

    expect(day?.level).toBe(2);
    expect(day?.releases.map((r) => r.version)).toEqual(["0.2.1", "0.2.0"]);
    expect(log.days.find((d) => d.date === "2026-06-15")?.level).toBe(0);
    const busy = buildShipLog(
      ["4", "3", "2", "1", "0"].map((n) => release(`1.0.${n}`, "2026-06-14")),
      "2026-06-14",
    );
    expect(busy.days[0]?.level).toBe(4);
  });

  it("labels the week each month starts in", () => {
    const log = buildShipLog(LOG, "2026-07-05");

    expect(log.months).toEqual([
      { label: "Jun", week: 0 },
      { label: "Jul", week: 3 },
    ]);
  });

  it("runs to the last release when the clock is behind it", () => {
    const days = buildShipLog(LOG, "2026-06-01").days;
    expect(days[days.length - 1]?.date).toBe("2026-07-02");
  });

  it("is empty without releases", () => {
    const log = buildShipLog([], "2026-07-05");
    expect(log.days).toEqual([]);
    expect(log.busiest).toBeNull();
  });

  it("covers the real changelog without gaps", () => {
    const log = buildShipLog(CHANGELOG, "2026-10-14");
    expect(log.releases).toBe(CHANGELOG.length);
    expect(log.days.reduce((sum, d) => sum + d.releases.length, 0)).toBe(CHANGELOG.length);
  });
});

describe("ship log readouts", () => {
  const log = buildShipLog(LOG, "2026-07-05");

  it("finds the day a version shipped", () => {
    expect(dayOfVersion(log, "0.2.0")?.date).toBe("2026-06-16");
    expect(dayOfVersion(log, "9.9.9")).toBeNull();
    expect(dayOfVersion(log, null)).toBeNull();
  });

  it("names a day's versions oldest to newest", () => {
    const one = log.days.find((d) => d.date === "2026-06-14");
    const two = log.days.find((d) => d.date === "2026-06-16");
    if (!one || !two) throw new Error("missing day");
    expect(versionsLabel(one)).toBe("v0.1.0");
    expect(versionsLabel(two)).toBe("v0.2.0 and v0.2.1");
    const three = buildShipLog(
      ["2", "1", "0"].map((n) => release(`1.0.${n}`, "2026-06-14")),
      "2026-06-14",
    ).days[0];
    if (!three) throw new Error("missing day");
    expect(versionsLabel(three)).toBe("v1.0.0 to v1.0.2");
  });

  it("leads with the newest release's hook sentence and counts the rest", () => {
    const day = log.days.find((d) => d.date === "2026-07-02");
    if (!day) throw new Error("missing day");
    expect(dayHeadline(day)).toEqual({ headline: "`Goals` got faster.", more: 1 });
    const off = log.days.find((d) => d.date === "2026-06-15");
    if (!off) throw new Error("missing day");
    expect(dayHeadline(off)).toBeNull();
  });

  it("formats dates without the machine's time zone", () => {
    expect(formatShipDate("2026-10-14")).toBe("Wed 14 Oct");
    expect(formatLongDate("2026-03-04")).toBe("4 Mar 2026");
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("Ken's About lines", () => {
  it("say where GG Coder started, and each fits his box", async () => {
    const { aboutLines } = await import("./about-content");
    const { KEN_LINE_MAX } = await import("./goal-ken-talk");
    const lines = aboutLines(buildShipLog(CHANGELOG, "2026-10-14"));

    expect(lines[1]?.text).toBe(
      "It started as a command-line tool in March 2026. This desktop app came along in June 2026.",
    );
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(KEN_LINE_MAX);
  });
});
