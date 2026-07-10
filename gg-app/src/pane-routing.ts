export const PRIMARY_PANE_ID = "primary";
export const SECONDARY_PANE_ID = "secondary";

export interface PaneTaggedEvent {
  paneId?: string;
  sessionId?: string;
}

export type PaneEventSubscriber<TEvent extends PaneTaggedEvent> = (event: TEvent) => void;

/**
 * Match an event to one pane. Legacy untagged frames belong only to the primary
 * pane; a supplied active session token additionally rejects stale bridges.
 */
export function matchesPaneEvent(
  event: PaneTaggedEvent,
  paneId: string,
  activeSessionId?: string,
): boolean {
  const matchesPane =
    event.paneId === paneId || (event.paneId === undefined && paneId === PRIMARY_PANE_ID);
  if (!matchesPane || activeSessionId === undefined) return matchesPane;
  if (event.sessionId === activeSessionId) return true;
  return event.sessionId === undefined && paneId === PRIMARY_PANE_ID;
}

/** Pure in-memory fan-out used by the Tauri event bridge and focused tests. */
export function createPaneEventFanout<TEvent extends PaneTaggedEvent>() {
  const subscribers = new Map<
    string,
    Set<{ listener: PaneEventSubscriber<TEvent>; activeSessionId?: string }>
  >();

  return {
    subscribe(
      paneId: string,
      listener: PaneEventSubscriber<TEvent>,
      activeSessionId?: string,
    ): () => void {
      const subscription = { listener, activeSessionId };
      const paneSubscribers = subscribers.get(paneId) ?? new Set();
      paneSubscribers.add(subscription);
      subscribers.set(paneId, paneSubscribers);
      return () => {
        paneSubscribers.delete(subscription);
        if (paneSubscribers.size === 0) subscribers.delete(paneId);
      };
    },

    dispatch(event: TEvent): void {
      const paneId = event.paneId ?? PRIMARY_PANE_ID;
      for (const subscription of subscribers.get(paneId) ?? []) {
        if (matchesPaneEvent(event, paneId, subscription.activeSessionId)) {
          subscription.listener(event);
        }
      }
    },
  };
}
