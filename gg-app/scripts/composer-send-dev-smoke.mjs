import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createDevAppDriver,
  DevAppActionError,
  draftEquals,
} from "../../packages/ggcoder/dist/dev-app-driver/index.js";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";

const { values: args } = parseArgs({ options: { identity: { type: "string" } } });
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const out = resolve(repoRoot, ".gg/eyes/out/composer-send-native", String(Date.now()));
await mkdir(out, { recursive: true });

const PANE = "pane-b";
const composer = `[data-pane-id="${PANE}"] textarea.input`;
const evidence = {
  boundary:
    "Isolated Windows developer Tauri WebView2 (minimized), real Rust IPC, credential-free fixture daemon, trusted CDP keyboard input through the shared dev-app driver. No real provider, installed app or visible-window check.",
  checks: [],
  gaps: [],
  cleanup: { status: "not-reached" },
  status: "running",
  stage: "fixture-start",
};

// Keep only what the verdict needs; page descriptions can carry project names.
const summarize = (outcome) => ({
  verdict: outcome.verdict,
  action: outcome.action,
  expectation: outcome.expectation,
  reason: outcome.reason,
  changed: outcome.changed,
  elapsedMs: outcome.elapsedMs,
  observed: outcome.observed && {
    draft: outcome.observed.page.draft,
    menuOpen: outcome.observed.page.menuOpen,
    status: outcome.observed.page.status,
    queued: outcome.observed.page.queued,
  },
});

const composerIdle = {
  label: "composer is empty with no menu open",
  usesPane: true,
  requireChange: false,
  judge: ({ page }) => (page.draft === "" && !page.menuOpen ? "met" : "pending"),
};

async function clearComposer(client, driver) {
  await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(composer)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await driver.waitFor("composer cleared", composerIdle, { pane: PANE });
}

async function checkSlashMenu(client, driver) {
  evidence.stage = "slash-menu";
  await driver.type("/", { into: composer, pane: PANE, expect: draftEquals("/") });
  const menuOpen = await driver
    .waitFor(
      "slash menu opens",
      {
        label: "slash menu opens",
        usesPane: true,
        judge: ({ page }) => (page.menuOpen ? "met" : "pending"),
      },
      { pane: PANE, deadlineMs: 2000 },
    )
    .then(
      () => true,
      (error) => {
        if (error instanceof DevAppActionError && error.outcome.verdict === "contradicted")
          return false;
        throw error;
      },
    );
  await clearComposer(client, driver);
  if (!menuOpen) {
    evidence.gaps.push(
      "Typing / opened no slash menu in the fixture app, so the menu-open refusal was not exercised natively (covered by driver unit tests only).",
    );
    return;
  }
  const refused = await driver.sendPrompt("/", { pane: PANE }).then(
    (outcome) => ({ sent: outcome }),
    (error) => {
      if (error instanceof DevAppActionError) return { refused: error.outcome };
      throw error;
    },
  );
  if (refused.sent) throw new Error("send prompt was confirmed although a slash menu was open");
  evidence.slashMenu = summarize(refused.refused);
  if (refused.refused.verdict !== "contradicted" || !/menu is open/.test(refused.refused.reason))
    throw new Error(
      `send prompt with a menu open was not refused for the menu: ${refused.refused.verdict}`,
    );
  if (refused.refused.elapsedMs >= 5000)
    throw new Error(
      `menu refusal took ${refused.refused.elapsedMs} ms, not within the default deadline`,
    );
  evidence.checks.push(
    `With the slash menu open, send prompt was contradicted in ${refused.refused.elapsedMs} ms and Enter was never pressed`,
  );
  await clearComposer(client, driver);
}

async function verifyWorkspace({ client, readAudit }) {
  const driver = createDevAppDriver({ client });
  evidence.stage = "fresh-pane-ready";
  await driver.waitFor("fresh pane composer is idle", composerIdle, {
    pane: PANE,
    deadlineMs: 15000,
  });
  const { sessionId } = await client.evaluate(
    `window.__TAURI_INTERNALS__.invoke('agent_state', { paneId: ${JSON.stringify(PANE)} })`,
  );
  await checkSlashMenu(client, driver);

  evidence.stage = "send-prompt";
  const auditStart = readAudit().length;
  const sent = await driver.sendPrompt("scene:stream", { pane: PANE });
  evidence.sendPrompt = summarize(sent);
  evidence.checks.push(
    `send prompt confirmed in ${sent.elapsedMs} ms: composer emptied and the pane shows ${sent.observed?.page.status}`,
  );

  evidence.stage = "fixture-received-prompt";
  // The daemon fixture writes its audit line before answering, so it is already there or never comes.
  const held = readAudit()
    .slice(auditStart)
    .find((entry) => entry.action === "prompt-held" && entry.sessionId === sessionId);
  if (!held) throw new Error("fixture daemon did not record the prompt for the fresh pane");
  evidence.checks.push("Fixture daemon recorded prompt-held for the fresh pane's own session");
  evidence.stage = "owned-process-cleanup";
}

try {
  await runCrossPaneProjectIsolationSmoke({
    identity: args.identity,
    stateScenes: true,
    verifyWorkspace: async (context) => {
      try {
        await verifyWorkspace(context);
      } catch (error) {
        evidence.assertion =
          error instanceof DevAppActionError
            ? `${error.outcome.action} ${error.outcome.verdict} (${error.outcome.expectation}): ${error.outcome.reason}`.slice(
                0,
                600,
              )
            : String(error instanceof Error ? error.message : error).slice(0, 600);
        if (error instanceof DevAppActionError) evidence.failedAction = summarize(error.outcome);
        throw error;
      }
    },
    onCleanup: (cleanup) => {
      evidence.cleanup = cleanup;
    },
  });
  if (evidence.cleanup.status !== "passed") throw new Error("owned-process cleanup did not pass");
  evidence.status = "passed";
  evidence.checks.push("Isolated fixture lifecycle completed and owned processes cleaned up");
} catch {
  evidence.status = "failed";
  // The shared launcher's error carries raw developer logs and profile paths; keep only our verdicts.
  evidence.error = "Native fixture or check failed; inspect stage, assertion and cleanup verdict.";
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, output: out, error: evidence.error }));
}
