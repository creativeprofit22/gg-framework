import { useCallback, useEffect, useState } from "react";
import type { SidecarEvent } from "./agent";
import { INITIAL_ACTIVITY, reduceTaskActivity } from "./task-activity";

export function useTaskActivity(sessionEpoch: number) {
  const [activity, setActivity] = useState(INITIAL_ACTIVITY);
  const handleActivityEvent = useCallback((event: SidecarEvent) => {
    const now = Date.now();
    setActivity((previous) => reduceTaskActivity(previous, event, now));
  }, []);
  useEffect(() => setActivity(INITIAL_ACTIVITY), [sessionEpoch]);
  return { activity, handleActivityEvent };
}
