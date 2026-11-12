import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

interface TrophyFrame {
  earned: number;
  total: number;
  unlocked: string[];
  eventNonce: string | null;
  origin?: boolean;
}

// Local Fork: upstream wires trophies through route modules the fork does not
// use, so the hooks were ported onto the fork's monolithic sidecar. This checks
// one ported hook end to end: the earning pane alone gets `origin`.
it("serves trophies daemon-wide and tags an unlock for the earning pane only", async () => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
    const options = { openAICodexContextProfile: "stable" } as const;
    const pane = await open((await manager.create(project, "openai", "gpt-5", options)).path);
    const other = await open((await manager.create(project, "openai", "gpt-5", options)).path);

    const initial = await request("/trophies", pane);
    expect(initial.status).toBe(200);
    const snapshot = (await initial.json()) as TrophyFrame;
    expect(snapshot.total).toBeGreaterThan(100);
    expect(snapshot.earned).toBe(0);

    const paneStream = await subscribe(pane);
    const otherStream = await subscribe(other);
    expect((await request("/new-session", pane, {})).status).toBe(200);

    const mine = (await paneStream.waitFor("trophies")).data as unknown as TrophyFrame;
    const theirs = (await otherStream.waitFor("trophies")).data as unknown as TrophyFrame;
    expect(mine.unlocked).toContain("fresh");
    expect(mine.origin).toBe(true);
    expect(theirs.eventNonce).toBe(mine.eventNonce);
    expect(theirs.origin).toBe(false);
  });
}, 60_000);
