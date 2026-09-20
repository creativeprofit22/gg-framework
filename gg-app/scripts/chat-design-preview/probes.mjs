import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveWsEndpoint } from "file:///C:/ggcoder-projects/uimaxxxing/eyes/_browser.mjs";

if (resolveWsEndpoint()) throw new Error("Inspect existing canonical browser endpoint before running probes");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL(`../../../.gg/eyes/out/chat-workspace-preview/probes-${Date.now()}/`, import.meta.url));
await mkdir(out, { recursive: true });
const env = { ...process.env, UIMAXXXING_EYES_NO_INSTALL: "1", EYES_PLAYWRIGHT_PATH: "file:///C:/ggcoder-projects/uimaxxxing/eyes/bin/node_modules/playwright/index.mjs" };
const results = [];
function run(tool, args, label, cwd = root) {
  const result = spawnSync(process.execPath, [`C:/ggcoder-projects/uimaxxxing/eyes/${tool}.mjs`, ...args], { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { tool, args, label, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
}
for (const variant of ["original", "reading", "light"]) {
  const url = `http://127.0.0.1:1420/__chat-design-preview?variant=${variant}&layout=one&size=16&tracking=normal&paragraphs=roomy&cap=on&markers=on&streaming=crisp&capture=1`;
  for (const viewport of ["1280x800", "390x844"]) {
    const result = run("visual", [url, "-o", `${out}${variant}-${viewport}.png`, "--viewport", viewport, "--viewport-only", "--loopback-only"], `${variant}-visual-${viewport}`);
    results.push(result);
    await writeFile(`${out}${result.label}.json`, JSON.stringify(result, null, 2));
    console.log(`${result.label}: exit ${result.exitCode}`);
  }
  const probes = [
    ["measure-text", [url, ".assistant-text", ".assistant-text p", "--all", "--viewport", "1280x800"]],
    ["measure-density", [url, "1280", "800", "--cards", "transcript=.transcript,composer=.inputwrap"]],
    ["a11y", [url, "--viewport", "1280x800"]],
    ["affordance", [url, "--viewport", "1280x800"]],
    ["palette", [`${out}${variant}-1280x800.png`]],
    ["extract-region", [`${out}${variant}-1280x800.png`, "--coords", "600,220,20,100"]],
    ["squint", [`${out}${variant}-1280x800.png`, "-o", `${out}${variant}-squint.png`]],
  ];
  for (const [tool, args] of probes) {
    const result = run(tool, args, `${variant}-${tool}`);
    results.push(result);
    await writeFile(`${out}${result.label}.json`, JSON.stringify(result, null, 2));
    console.log(`${result.label}: exit ${result.exitCode}`);
  }
}
for (const variant of ["reading", "light"]) results.push(run("drift", [`${out}${variant}-1280x800.png`, `${out}original-1280x800.png`, "--strict-size", "-o", `${out}${variant}-drift`], `${variant}-drift`));
results.push(run("states", [], "states", `${root}gg-app`));
await writeFile(`${out}summary.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output: out, results: results.map(({ label, exitCode, error }) => ({ label, exitCode, error })) }));
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
