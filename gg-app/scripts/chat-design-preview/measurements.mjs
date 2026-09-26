import { previewReady } from "../../src/dev/chat-design-preview/readiness.mjs";

// For opaque computed rgb() or six-digit hex samples, not gradient/background compositing.
function luminance(color) {
  const channels = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1).match(/../g).map((v) => parseInt(v, 16))
    : /^rgba?\([\d.,\s]+\)$/.test(color) ? color.match(/[\d.]+/g).map(Number) : [];
  if (![3, 4].includes(channels.length) || (channels.length === 4 && channels[3] !== 1) || channels.slice(0, 3).some((v) => !Number.isFinite(v) || v < 0 || v > 255)) throw new Error("Contrast requires opaque RGB or six-digit hex samples");
  const values = channels.slice(0, 3);
  return values.map((value) => value / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrastRatio(fg, bg) {
  const values = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export async function measurePreview(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    };
    const root = document.getElementById("root");
    const active = document.activeElement;
    const settings = Object.fromEntries(["variant", "size", "tracking", "paragraphs", "cap", "markers", "streaming", "code"].map((key) => [key, root?.dataset[`preview${key[0].toUpperCase()}${key.slice(1)}`] ?? null]));
    return {
      settings,
      focus: active && { tag: active.tagName, id: active.id, paneId: active.closest(".workspace-pane-slot")?.dataset.paneId ?? null, role: active.getAttribute("role"), label: active.getAttribute("aria-label"), focusVisible: active.matches(":focus-visible") },
      splits: [...document.querySelectorAll('[role="separator"][aria-valuenow]')].map((element) => ({ label: element.getAttribute("aria-label"), value: element.getAttribute("aria-valuenow"), geometry: rect(element) })),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, zoom: getComputedStyle(document.documentElement).zoom },
      panes: [...document.querySelectorAll(".workspace-pane-slot")].map((pane) => {
        const prose = pane.querySelector(".assistant-text");
        const paragraph = prose?.querySelector("p");
        const computed = prose ? getComputedStyle(prose) : null;
        return { id: pane.dataset.paneId, focused: pane.classList.contains("pane-focused"), geometry: rect(pane), prose: rect(prose),
          type: computed && { size: computed.fontSize, lineHeight: computed.lineHeight, tracking: computed.letterSpacing, paragraphMargin: paragraph && getComputedStyle(paragraph).marginBlock },
          transcript: rect(pane.querySelector(".transcript")), header: rect(pane.querySelector(".chat-head")), composer: rect(pane.querySelector(".inputwrap")),
          draft: pane.querySelector("textarea")?.value ?? null,
        };
      }),
      errors: window.__chatPreview?.errors ?? ["Missing preview bootstrap"],
    };
  });
}

// Final state may have changed content (for example a recovered retry), but must
// still satisfy the fixture's structural readiness contract. Do not reuse ready=true.
export async function requireCapture(page, expectedCount, state = "completed") {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  if (!await page.evaluate(previewReady, { expectedCount, state, requireSignal: true })) throw new Error("Invalid final preview workspace");
  if (await page.getByText("invalid Roadmap draft response", { exact: true }).count()) throw new Error("Invalid Roadmap fixture response");
  const result = await measurePreview(page);
  if (result.errors.length) throw new Error(`Fixture errors: ${result.errors.join("; ")}`);
  const positive = (value) => Number.isFinite(value) && value > 0;
  if (!positive(result.viewport.width) || !positive(result.viewport.height) || !positive(result.viewport.dpr) || !positive(Number(result.viewport.zoom))
    || result.panes.length !== expectedCount || result.panes.some((pane) => !positive(pane.geometry?.width) || !positive(pane.geometry?.height))) {
    throw new Error("Invalid final preview workspace geometry");
  }
  return result;
}

export async function requireReady(page, expectedCount, state = "completed", timeout = 30000) {
  await page.waitForFunction(previewReady, { expectedCount, state, requireSignal: true }, { timeout });
  if (await page.getByText("invalid Roadmap draft response", { exact: true }).count()) throw new Error("Invalid Roadmap fixture response");
  const result = await measurePreview(page);
  if (result.errors.length) throw new Error(`Fixture errors: ${result.errors.join("; ")}`);
  await page.evaluate(() => { window.__chatPreview.ready = true; });
  return result;
}
