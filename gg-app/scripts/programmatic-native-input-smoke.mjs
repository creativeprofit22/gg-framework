// Bounded input/layout evidence for the existing isolated developer fixture.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { processTreeSnapshot, readProcessTable } from "./workspace-shell-evidence.mjs";
const exec = promisify(execFile);

export async function createNativeInputSmoke(client, rootPid, audit, waitFor) {
  const evidence = { input: "CDP trusted keyboard/pointer input into visible native WebView2", focus: [], layouts: [], screenshots: [], screenReader: "not tested" };
  const save = () => writeFileSync(join(audit, "native-input.json"), JSON.stringify(evidence, null, 2));
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers, text: key === "Enter" ? "\r" : key === " " ? " " : undefined });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
  };
  const capture = async (name) => {
    const image = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(audit, `${name}.png`), Buffer.from(image.data, "base64"));
    evidence.screenshots.push(`${name}.png`); save();
  };
  const resize = async (width, height) => {
    assert.ok([width, height, rootPid].every((n) => Number.isSafeInteger(n) && n > 0));
    const tree = processTreeSnapshot(await readProcessTable(), rootPid);
    assert.ok(tree.pids.length);
    const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SmokeWindow { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int z,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$windows = @(Get-Process -Id ${tree.pids.join(",")} -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'gg-app' -and $_.MainWindowHandle -ne 0 })
if ($windows.Count -ne 1) { throw 'Expected one owned developer window' }
$p=$windows[0]; $h=$p.MainWindowHandle
[SmokeWindow]::ShowWindow($h,9) | Out-Null
if (-not [SmokeWindow]::MoveWindow($h,30,30,${width},${height},$true)) { throw 'Native resize failed' }
$front=[SmokeWindow]::SetForegroundWindow($h)
@{pid=$p.Id; handle=$h.ToInt64(); width=${width}; height=${height}; foregroundRequested=$front} | ConvertTo-Json -Compress`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    evidence.window = JSON.parse(stdout); save();
    await client.send("Page.bringToFront");
  };
  const focus = async (expression, label, backwards = false) => {
    await waitFor(`keyboard target ${label}`, () => client.evaluate(`Boolean(${expression}) && !(${expression}).disabled`));
    backwards = backwards || await client.evaluate(`Boolean(document.activeElement.compareDocumentPosition(${expression}) & Node.DOCUMENT_POSITION_PRECEDING)`);
    let steps = 0;
    const trace = [];
    while (!(await client.evaluate(`document.activeElement === (${expression})`))) {
      trace.push(await client.evaluate(`({tag:document.activeElement.tagName,text:document.activeElement.textContent.slice(0,100),before:!!(document.activeElement.compareDocumentPosition(${expression}) & Node.DOCUMENT_POSITION_PRECEDING)})`));
      if (steps >= 140) { evidence.failedTraversal = {label,trace}; save(); }
      assert.ok(steps++ < 140, `Tab could not reach ${label}`);
      backwards = trace.at(-1).before;
      await key("Tab", "Tab", 9, backwards ? 8 : 0);
    }
    const observation = await client.evaluate(`(() => { const e=document.activeElement, r=e.getBoundingClientRect(), s=getComputedStyle(e); return {label:e.textContent.trim(), focusVisible:e.matches(':focus-visible'), outline:s.outline, rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}, viewport:{width:innerWidth,height:innerHeight}, hit:e.contains(document.elementFromPoint(Math.max(1,Math.min(innerWidth-1,(r.left+r.right)/2)),Math.max(1,Math.min(innerHeight-1,(r.top+r.bottom)/2))))}; })()`);
    evidence.focus.push({ target: label, steps, backwards, ...observation }); save();
    assert.equal(observation.focusVisible, true, `Visible keyboard focus: ${label}`);
    assert.equal(observation.hit, true, `Focused control not obscured: ${label}`);
    return observation;
  };
  const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`;
  const activate = async (expression, label, space = false) => {
    await focus(expression, label);
    await capture(`focus-${evidence.focus.length}`);
    await key(space ? " " : "Enter", space ? "Space" : "Enter", space ? 32 : 13);
  };
  const zoom = async (factor) => {
    await key("0", "Digit0", 48, 2);
    await waitFor("100% app shortcut", () => client.evaluate(`localStorage.getItem('gg-app:zoom') === '1'`));
    for (let step = 1; step <= Math.round((factor - 1) / 0.05); step++) {
      await key("=", "Equal", 187, 2);
      const expected = Math.round((1 + step * 0.05) * 100) / 100;
      await waitFor(`app zoom ${expected}`, () => client.evaluate(`Math.abs(Number(localStorage.getItem('gg-app:zoom')) - ${expected}) < 0.001`));
    }
    await waitFor("zoom overlay cleared", () => client.evaluate(`!document.querySelector('.zoom-overlay')`));
    evidence.zoomMethod = "Actual app Ctrl+= / Ctrl+0 keyboard shortcut, persisted by ZoomController; app uses CSS zoom, not WebView native page zoom"; save();
  };
  const layout = async (name) => {
    const result = await client.evaluate(`(() => { const e=document.querySelector('.programmatic-chat'); const r=e.getBoundingClientRect(); return {name:${JSON.stringify(name)}, zoom:getComputedStyle(document.documentElement).zoom, storedZoom:localStorage.getItem('gg-app:zoom'), viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, section:{client:e.clientWidth,scroll:e.scrollWidth,left:r.left,right:r.right}, document:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}, selected:document.querySelector('.programmatic-row[aria-pressed="true"]')?.textContent}; })()`);
    evidence.layouts.push(result); save();
    assert.ok(result.section.scroll <= result.section.client + 1, `${name}: opportunity horizontal overflow`);
    assert.ok(result.document.scroll <= result.document.client + 1, `${name}: document horizontal overflow`);
    for (const label of ["Review setup", "Refresh results", "Check for opportunities"]) await focus(button(label), `${name}: ${label}`);
    await focus("document.querySelector('.programmatic-detail summary')", `${name}: evidence`);
    await capture(name);
  };
  const pointer = async () => {
    const expression = button("Refresh results");
    await focus(expression, "pointer baseline");
    const rect = await client.evaluate(`(() => {const r=(${expression}).getBoundingClientRect(); return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};})()`);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect });
    await waitFor("pointer refresh complete", () => client.evaluate(`!document.querySelector('.programmatic-chat [role="status"]')?.textContent.includes('Loading')`));
    const observation = await client.evaluate(`(() => {const e=${expression}; return {focusVisible:e.matches(':focus-visible'),outline:getComputedStyle(e).outline};})()`);
    evidence.pointer = observation; save();
    assert.equal(observation.focusVisible, false, "Pointer does not retain keyboard focus ring");
    await capture("pointer-resting");
    await focus("document.querySelector('.programmatic-detail summary')", "keyboard resumes after pointer", true);
  };
  await resize(1280, 900);
  return { evidence, save, key, capture, resize, focus, button, activate, zoom, layout, pointer };
}
