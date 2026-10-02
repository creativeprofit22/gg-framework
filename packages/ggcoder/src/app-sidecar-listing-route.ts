/**
 * HTTP result for a picker listing route (`GET /projects`, `GET /sessions`).
 *
 * A listing failure must reach the desktop picker as an error so it can show
 * its Retry block; answering 200 with an empty array would read as "no history".
 */
export type ListingRouteResponse<K extends string, T> =
  { status: 200; body: Record<K, T[]> } | { status: 500; body: { error: string } };

export async function listingRouteResponse<K extends string, T>(
  key: K,
  load: () => Promise<T[]>,
  onError: (message: string) => void,
): Promise<ListingRouteResponse<K, T>> {
  try {
    const items = await load();
    return { status: 200, body: { [key]: items } as Record<K, T[]> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(message);
    return { status: 500, body: { error: message } };
  }
}
