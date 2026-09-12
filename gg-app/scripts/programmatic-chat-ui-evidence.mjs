import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { isProgrammaticChatResponse } from "../../packages/gg-core/src/programmatic-chat-contract.ts";

// Browser-only changed-component evidence. Native actions are NOT exercised here.
const origin = process.env.GG_UI_EVIDENCE_ORIGIN ?? "http://127.0.0.1:1421";
const output = resolve(".gg/evidence/programmatic-chat-ui");
mkdirSync(output, { recursive: true });
const hash = "a".repeat(64);
const summary = { id: hash, expectedOutput: "Review repeatable packaging checks for the desktop application", state: "discovered", presence: "present", mutationPaths: [], actions: { run: { available: true, reason: "Ready to run." }, dismiss: { available: true, reason: "Ready to dismiss." } }, route: { available: true, command: "research", reason: "Research is available on this machine.", machineLocal: true } };
const state = { generation: "fixture", epoch: 0, selectedId: hash, detailSnapshot: hash, operation: null, error: null, reconcile: false, notice: "One opportunity ready to review.", missingSelection: false, proposal: null, proposalApprovable: false,
  report: { status: "current", reason: "Approved configuration is current.", fingerprint: hash, snapshot: hash, offset: 0, total: 1, scan: { available: true, reason: "Approved profile is ready to scan." }, rows: [summary] },
  detail: { summary, trigger: "Changes to the desktop application's manifest", verification: "Produce a read-only report with linked findings", risks: ["The specialist is installed on this machine only."], evidence: [{ basis: "observed", message: "Desktop manifest found", location: { path: `src/${"long-project-directory/".repeat(15)}package.json`, startLine: 1 } }], evidenceTruncated: false } };
assert.ok(isProgrammaticChatResponse({ version: 1, ok: true, action: "report", report: state.report }), "Preview report must match the shared contract");
assert.ok(isProgrammaticChatResponse({ version: 1, ok: true, action: "detail", snapshot: hash, detail: state.detail }), "Preview detail must match the shared contract");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = { native: false, mocked: ["report and actions"], screenshots: [], checks: {}, unverified: ["Human-visible native focus", "Windows screen-reader speech", "Full application WCAG conformance"] };
try {
  await page.route("**/__programmatic-preview", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Opportunity review evidence fixture</title></head><body><main id="fixture"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
await import('/@vite/client');
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {ProgrammaticChat} = await import('/src/ProgrammaticChat.tsx');
await import('/src/App.css');
const root = ReactDOM.createRoot(document.getElementById('fixture'));
window.renderFixture = (state) => root.render(React.createElement(ProgrammaticChat,{state,busy:false,planMode:false,onAction:()=>{},onSelect:()=>{},onRun:()=>{}}));
window.renderFixture(${JSON.stringify(state)});
</script><style>body{overflow:auto;background:var(--bg);color:var(--text)}#fixture{max-width:900px;margin:auto;padding:16px}</style></body></html>` }));
  await page.goto(`${origin}/__programmatic-preview`);
  await page.getByRole("heading", { name: "Opportunities", exact: true }).waitFor();
  await page.getByText("Evidence and verification", { exact: true }).click();
  const capture = async (name) => { await page.screenshot({ path: `${output}/${name}.png`, fullPage: true }); results.screenshots.push(`${name}.png`); };
  await capture("desktop");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({ name: document.activeElement?.textContent, ring: getComputedStyle(document.activeElement).outlineStyle, visible: document.activeElement.matches(":focus-visible") }));
  assert.equal(focused.visible, true); assert.notEqual(focused.ring, "none");
  results.checks.keyboardFocus = focused;
  await capture("keyboard-focus");
  await page.getByRole("button", { name: "Refresh report" }).click();
  results.checks.pointerFocus = await page.getByRole("button", { name: "Refresh report" }).evaluate((button) => button.matches(":focus-visible"));
  assert.equal(results.checks.pointerFocus, false);
  const overflow = () => page.locator(".programmatic-chat").evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  await page.setViewportSize({ width: 320, height: 900 });
  results.checks.reflow320 = await overflow();
  assert.ok(results.checks.reflow320.scroll <= results.checks.reflow320.width + 1);
  await capture("narrow-320");
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator("html").evaluate((node) => { node.style.zoom = "2"; });
  results.checks.zoom200 = await overflow(); assert.ok(results.checks.zoom200.scroll <= results.checks.zoom200.width + 1);
  await capture("zoom-200");
  await page.locator("html").evaluate((node) => { node.style.zoom = ""; });
  await page.addStyleTag({ content: ".programmatic-chat * {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}.programmatic-chat p{margin-bottom:2em!important}" });
  await page.setViewportSize({ width: 320, height: 900 });
  results.checks.textSpacing = await overflow(); assert.ok(results.checks.textSpacing.scroll <= results.checks.textSpacing.width + 1);
  await capture("text-spacing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  results.checks.reducedMotion = await page.locator(".programmatic-chat button").first().evaluate((node) => ({ duration: getComputedStyle(node).transitionDuration, animation: getComputedStyle(node).animationName }));
  assert.equal(results.checks.reducedMotion.duration, "0s");
  await page.emulateMedia({ forcedColors: "active" });
  results.checks.forcedSelectionBorder = await page.locator('.programmatic-row[aria-pressed="true"]').evaluate((node) => getComputedStyle(node).borderTopWidth);
  assert.equal(results.checks.forcedSelectionBorder, "2px");
  await capture("forced-colors");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  results.checks.contrast = await page.evaluate(() => {
    const luminance = (rgb) => { const v = rgb.match(/[\d.]+/g).slice(0,3).map(Number).map((c)=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]; };
    const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    const style=getComputedStyle(document.querySelector('.programmatic-chat'));
    const background=getComputedStyle(document.body).backgroundColor;
    const button=getComputedStyle(document.querySelector('.programmatic-chat .btn-primary'));
    return { text:ratio(style.color,background), primary:ratio(button.color,button.backgroundColor), focus:ratio(button.backgroundColor,background) };
  });
  assert.ok(results.checks.contrast.text >= 4.5); assert.ok(results.checks.contrast.primary >= 4.5); assert.ok(results.checks.contrast.focus >= 3);
  results.checks.accessibilityTree = await page.locator(".programmatic-chat").ariaSnapshot();
  assert.deepEqual(errors, []);
  results.passed = true;
} finally {
  results.errors = errors;
  writeFileSync(`${output}/result.json`, JSON.stringify(results, null, 2) + "\n");
  await browser.close();
}
console.log(`Browser evidence: ${output}`);
