import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";

/*
 * Developer-app smoke: a trophy earned in a split pane rests, fully visible,
 * in its own pane's dock directly above the message box (the deck) without
 * covering it, and the conversation reserves its height (--dock-h). Checked in
 * the left and right pane at wide, narrow and short window sizes.
 * Regression: `.app > *` (App.css) out-cascaded the card's `position: fixed`,
 * so it sat in flow underneath the dock; fixed instead covered the input.
 */

const out = resolve(
  process.env.GG_TROPHY_SMOKE_EVIDENCE ??
    resolve(fileURLToPath(new URL("../..", import.meta.url)), ".gg/eyes/out/trophy-unlock-dev", String(Date.now())),
);
await mkdir(out, { recursive: true });
const evidence = {
  boundary: "Isolated Windows developer Tauri WebView2, real Rust IPC/session routing and SSE forwarding, controlled credential-free fixture daemon. CSS viewport emulation for the narrow case, not OS window resizing, installed app or real trophy engine.",
  checks: [],
  measurements: [],
  cleanup: { status: "not-reached" },
  status: "running",
};

async function waitFor(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise((done) => setTimeout(done, 75));
  }
  throw new Error(`Trophy smoke timed out: ${label}`);
}

const PANE = "trophy-right";
const OTHER = { primary: PANE, [PANE]: "primary" };

/** Where the face-up card sits, and what actually paints on top of it. */
const measure = (pane) => `(() => {
  const slot = document.getElementById("workspace-pane-${pane}");
  const host = slot?.querySelector(".trophy-unlock");
  const wrap = host?.querySelector(".tu-wrap");
  if (!slot || !host || !wrap) return null;
  const r = wrap.getBoundingClientRect();
  const s = slot.getBoundingClientRect();
  const dock = slot.querySelector(".app > .dock");
  const d = dock?.getBoundingClientRect();
  const deck = dock?.querySelector(":scope > .deck");
  const k = deck?.getBoundingClientRect();
  const frame = slot.querySelector(".app > .conversation-stack > .transcript-frame");
  const inset = 8;
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + inset, r.top + inset],
    [r.right - inset, r.top + inset],
    [r.left + inset, r.bottom - inset],
    [r.right - inset, r.bottom - inset],
  ];
  const hits = points.map(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    return { x: Math.round(x), y: Math.round(y), onCard: Boolean(top && host.contains(top)), top: top ? top.tagName.toLowerCase() + (top.className && typeof top.className === "string" ? "." + top.className.split(/\\s+/).slice(0, 2).join(".") : "") : null };
  });
  const round = (b) => b && { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    position: getComputedStyle(host).position,
    card: round(r),
    pane: round(s),
    dock: round(d),
    deck: round(k),
    inDock: Boolean(dock && dock.contains(host)),
    aboveDeck: Boolean(k && r.bottom <= k.top + 0.5),
    reservedDockPx: frame ? parseFloat(frame.style.getPropertyValue("--dock-h")) : null,
    dockPx: dock ? dock.offsetHeight : null,
    insidePane: r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5,
    hits,
    otherPaneCards: document.querySelectorAll("#workspace-pane-${OTHER[pane]} .trophy-unlock").length,
  };
})()`;

async function earnAndCheck(client, label, pane = PANE) {
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_prompt", { paneId: ${JSON.stringify(pane)}, text: "scene:trophy", attachments: [], meta: null })`);
  await waitFor(client, `Boolean(document.querySelector("#workspace-pane-${pane} .trophy-unlock .tu-wrap[data-flat]"))`, `${label}: face-up trophy card`);
  // Hold it face up while we look (hover/focus pauses the auto-dismiss).
  await client.evaluate(`document.querySelector("#workspace-pane-${pane} .tu-wrap button")?.focus(); true`);
  const m = await client.evaluate(measure(pane));
  const image = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(out, `${label}.png`), Buffer.from(image.data, "base64"));
  evidence.measurements.push({ label, ...m });
  assert.ok(m, `${label}: card rendered`);
  assert.equal(m.otherPaneCards, 0, `${label}: only the earning pane celebrates`);
  assert.equal(m.position, "relative", `${label}: card is in flow`);
  assert.ok(m.inDock, `${label}: card is a dock row`);
  assert.ok(m.insidePane, `${label}: card fits inside its pane ${JSON.stringify(m)}`);
  assert.ok(m.aboveDeck, `${label}: card does not cover the message box ${JSON.stringify(m)}`);
  assert.equal(m.reservedDockPx, m.dockPx, `${label}: conversation reserves the dock, card included`);
  assert.ok(m.hits.every((hit) => hit.onCard), `${label}: card paints on top ${JSON.stringify(m.hits)}`);
  evidence.checks.push(`${label} (${pane}): in dock above the message box (gap ${m.deck.top - m.card.bottom}px), inside ${m.pane.right - m.pane.left}x${m.pane.bottom - m.pane.top} pane, topmost at 5 points, --dock-h ${m.reservedDockPx}px reserved`);
  // Let it file away before the next one.
  await client.evaluate(`document.activeElement?.blur(); true`);
  await waitFor(client, `!document.querySelector("#workspace-pane-${pane} .trophy-unlock")`, `${label}: card files away`, 20000);
}

async function verifyWorkspace({ client, projectA, projectB }) {
  const leaf = (paneId) => ({ type: "leaf", paneId });
  const layout = {
    version: 9,
    focusedPaneId: "primary",
    root: { type: "split", direction: "horizontal", size: { type: "ratio", value: 50 }, first: leaf("primary"), second: leaf(PANE) },
    panes: {
      primary: { kind: "agent", mode: "code", cwd: projectA, sessionPath: null },
      [PANE]: { kind: "agent", mode: "code", cwd: projectB, sessionPath: null },
    },
  };
  await client.evaluate(`localStorage.setItem('gg-workspace-layout-recursive:main', ${JSON.stringify(JSON.stringify(layout))}); location.reload(); true`);
  await waitFor(client, `document.querySelectorAll('[data-pane-id]').length === 2 && document.querySelectorAll('[data-pane-id] textarea').length === 2`, "two developer panes");
  try {
    await earnAndCheck(client, "wide");
    await earnAndCheck(client, "wide-left", "primary");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
    await new Promise((done) => setTimeout(done, 400));
    await earnAndCheck(client, "narrow");
    await earnAndCheck(client, "narrow-left", "primary");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 480, deviceScaleFactor: 1, mobile: false });
    await new Promise((done) => setTimeout(done, 400));
    await earnAndCheck(client, "short");
    await earnAndCheck(client, "short-left", "primary");
  } catch (error) {
    evidence.assertion = error instanceof Error ? error.message.slice(0, 1200) : String(error);
    throw error;
  } finally {
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

try {
  await runCrossPaneProjectIsolationSmoke({
    identity: "com.ggcoder.local-fork",
    stateScenes: true,
    verifyWorkspace,
    onCleanup: (cleanup) => {
      evidence.cleanup = cleanup;
    },
  });
  assert.equal(evidence.cleanup.status, "passed");
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  // The shared launcher's error carries raw developer logs and profile paths; keep ours only.
  evidence.error = evidence.assertion ?? "Native fixture failed before the trophy checks; inspect the retained fixture log.";
  // Console only, first line: enough to tell a build timeout from a failed check.
  console.error(String(error instanceof Error ? error.message : error).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, output: out, error: evidence.error, checks: evidence.checks }));
}
