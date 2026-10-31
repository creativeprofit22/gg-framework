// Smoke: a silent long command moved to the background survives past the old
// 12-minute silence kill, notifies once, and exits cleanly. Runs against built
// dist with the real ProcessManager and bash tool. `--fast` runs the same
// timeline at 1/60 scale to check the script itself.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentNotificationQueue } from "../dist/core/agent-notifications.js";
import { ProcessManager } from "../dist/core/process-manager.js";
import { createBashTool } from "../dist/tools/bash.js";

const fast = process.argv.includes("--fast");
// Real defaults: 120s yield, 600s quiet notice, 60 min hard limit.
const settings = fast ? { yieldSeconds: 2, inactivitySeconds: 10, hardLimitMinutes: 1 } : undefined;
const lifeMs = fast ? 13_000 : 13 * 60_000;
const aliveCheckMs = fast ? 12_500 : 12.5 * 60_000;
const quietMs = fast ? 10_000 : 600_000;

const startedAt = Date.now();
const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
const log = (message) => console.log(`[${elapsed()}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text(result) {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
  return String(content ?? result);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-quiet-handoff-"));
const script = path.join(dir, "silent.cjs");
await fs.writeFile(
  script,
  `console.log('start pid:' + process.pid); setTimeout(() => console.log('done'), ${lifeMs});`,
);
const command = `node "${script.split(path.sep).join("/")}"`;

const notifications = new AgentNotificationQueue();
const processManager = new ProcessManager({ notifications });
const tool = createBashTool(
  dir,
  processManager,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  settings ? () => settings : undefined,
);

const seen = [];
const drain = () => seen.push(...notifications.drain().map((n) => ({ ...n, at: elapsed() })));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  log(`${ok ? "ok" : "FAIL"}: ${message}`);
};

let id = "";
try {
  log(`mode=${fast ? "fast" : "real"} command=${command}`);
  const handOff = text(
    await tool.execute(
      { command },
      { signal: new AbortController().signal, toolCallId: "quiet-handoff-smoke" },
    ),
  );
  id = /moved to background task (\S+)/.exec(handOff)?.[1] ?? "";
  check(id !== "", "the command moved to the background");
  check(
    handOff.includes("Silence only sends you a notice; it never stops the command."),
    "the hand-off says silence only notifies",
  );

  while (Date.now() - startedAt < aliveCheckMs) {
    drain();
    await sleep(1_000);
  }
  drain();
  const atCheck = await processManager.readOutput(id);
  const record = processManager.list().find((proc) => proc.id === id);
  check(atCheck.isRunning, `still running at ${elapsed()}s, past the quiet limit`);
  check((record?.stopReason ?? null) === null, "no automatic stop reason");

  const deadline = startedAt + lifeMs + 60_000;
  while (processManager.list().find((proc) => proc.id === id)?.exitCode === null) {
    if (Date.now() > deadline) break;
    drain();
    await sleep(1_000);
  }
  await sleep(2_000);
  drain();
  const final = processManager.list().find((proc) => proc.id === id);
  const { output } = await processManager.readOutput(id, true);
  check(final?.exitCode === 0, `exited cleanly (code ${final?.exitCode ?? "none"})`);
  check((final?.stopReason ?? null) === null, "exit was not an automatic stop");
  check(output.includes("done"), "the command finished its own work");

  const silence = seen.filter((n) => n.id === id && /has produced no output for/.test(n.text));
  check(silence.length === 1, `exactly one silence notice (got ${silence.length})`);
  const notice = silence[0];
  if (notice) {
    check(notice.at * 1000 >= quietMs, `notice came after the quiet limit (at ${notice.at}s)`);
    check(notice.text.includes(id), "notice names the task");
    check(/running \S+ in total/.test(notice.text), "notice gives total run time");
    check(notice.text.includes("Log:"), "notice gives the log path");
    log(`notice: ${notice.text.replace(/\s+/g, " ")}`);
  }
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  processManager.shutdownAll();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

const summary = JSON.stringify({
  mode: fast ? "fast" : "real",
  id,
  elapsedSeconds: elapsed(),
  failures,
});
console.log(`QUIET_HANDOFF_SMOKE ${failures.length === 0 ? "PASS" : "FAIL"} ${summary}`);
process.exitCode = failures.length === 0 ? 0 : 1;
