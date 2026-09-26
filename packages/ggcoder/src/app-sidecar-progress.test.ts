import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { signProgress } from "./core/progress/store.js";
import type { ProgressFile } from "./core/progress/types.js";
import { MAX_LEVEL, xpForLevel } from "./core/progress/ranks.js";
import { parseProgressSnapshot } from "@kenkaiiii/gg-core/progress-contract";
import { withRealSidecar } from "./test-support/real-sidecar.js";

it.each([-1, 0, 100])("GET /progress and SSE agree at cap + %i XP", async (extra) => {
  const xp = xpForLevel(MAX_LEVEL) + extra;
  await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const response = await request("/progress", pane);
    expect(response.status).toBe(200);
    const rpc = parseProgressSnapshot(await response.json());
    const stream = await subscribe(pane);
    // Simulate another daemon's award in this fixture's disposable home only.
    const progressPath = path.join(project, "..", ".gg", "progress.json");
    const file = JSON.parse(await fs.readFile(progressPath, "utf8")) as ProgressFile;
    file.lastEvent = { nonce: "fixture-progress-cap", levelUp: null };
    file.sig = signProgress(file);
    await fs.writeFile(progressPath, JSON.stringify(file));
    const event = parseProgressSnapshot((await stream.waitFor("progress")).data);
    expect(rpc.maxLevel).toBe(MAX_LEVEL);
    expect(event.maxLevel).toBe(MAX_LEVEL);
    expect(rpc.level).toBe(extra < 0 ? MAX_LEVEL - 1 : MAX_LEVEL);
    expect(rpc.xp).toBe(xp);
    expect(event).toEqual({ ...rpc, eventNonce: "fixture-progress-cap", origin: false });
    expect(parseProgressSnapshot(await (await request("/progress", pane)).json())).toEqual({
      ...rpc, eventNonce: "fixture-progress-cap",
    });
  }, { progressXp: xp });
}, 60_000);
