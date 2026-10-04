import { useEffect, useState } from "react";
import { hourOf } from "./scene-light";

/** The scenery's light moves on this often; a minute is far finer than you can see. */
const TICK_MS = 60_000;

/**
 * The local time as a fractional hour (14:30 → 14.5), refreshed every minute.
 * `now` is injectable for tests and previews.
 */
export function useLocalHour(now: () => Date = () => new Date()): number {
  const [clock] = useState(() => now);
  const [hour, setHour] = useState(() => hourOf(clock()));
  useEffect(() => {
    const id = window.setInterval(() => setHour(hourOf(clock())), TICK_MS);
    return () => window.clearInterval(id);
  }, [clock]);
  return hour;
}
