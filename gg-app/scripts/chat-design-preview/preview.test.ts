import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { WORKSPACE_LAYOUT_VERSION, validateWorkspaceLayoutCandidate, saveWorkspaceLayout } from "../../src/workspace-layout";
import { createLayout, layoutNames, paneCounts, parsePreviewOptions } from "./layouts.mjs";
import { fixtureResponses, fixtureScript } from "./fixtures.mjs";
import { chatDesignPreviewPlugin, previewEnabled } from "./vite-plugin.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizePreviewRoot, previewCheckoutIdentity } from "./server-identity.mjs";
import { chromium } from "playwright";
import { capturePreview } from "./run.mjs";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

async function previewResponse(root = appRoot) {
  const use = vi.fn();
  chatDesignPreviewPlugin().configureServer({
    config: { root }, middlewares: { use },
    transformIndexHtml: async (_path: string, html: string) => html,
  });
  const headers = new Headers();
  const res = { statusCode: 200, setHeader: (name: string, value: string) => headers.set(name, value), end: vi.fn() };
  await use.mock.calls[0][0]({ url: "/__chat-design-preview", method: "GET", headers: { host: "127.0.0.1:1420" } }, res, vi.fn());
  return new Response(res.end.mock.calls[0][0], { status: res.statusCode, headers });
}

describe("preview server provenance", () => {
  it("accepts the plugin's matching realpath identity before launching", async () => {
    const response = await previewResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chat-preview")).toBe("synthetic-only-v1");
    expect(response.headers.get("x-chat-preview-checkout")).toBe(previewCheckoutIdentity(appRoot));
    expect(response.headers.get("x-chat-preview-checkout")).toMatch(/^[a-f0-9]{64}$/);
    expect(previewCheckoutIdentity(join(appRoot, "scripts", ".."))).toBe(previewCheckoutIdentity(appRoot));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const reachedLaunch = new Error("test stops at owned browser launch");
    vi.mocked(chromium.launch).mockRejectedValue(reachedLaunch);
    await expect(capturePreview()).rejects.toBe(reachedLaunch);
    expect(chromium.launch).toHaveBeenCalledExactlyOnceWith({ headless: true });
  });

  it("rejects a different checkout with the same capability marker before launch", async () => {
    const response = await previewResponse();
    response.headers.set("X-Chat-Preview-Checkout", previewCheckoutIdentity(join(appRoot, "..")));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(capturePreview()).rejects.toThrow(/checkout identity/i);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it.each([404, 500, 503])("rejects HTTP %s even with both matching markers before launch", async (status) => {
    const response = await previewResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failure", { status, headers: response.headers })));
    await expect(capturePreview()).rejects.toThrow(`HTTP failure: ${status}`);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it.each([null, "other-preview"])("rejects capability marker %s despite matching identity", async (marker) => {
    const response = await previewResponse();
    if (marker === null) response.headers.delete("X-Chat-Preview");
    else response.headers.set("X-Chat-Preview", marker);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(capturePreview()).rejects.toThrow(/explicitly enabled preview server/i);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("normalizes Windows drive, slash and extended paths without collapsing component case", () => {
    const expected = "c:/Projects/checkout/gg-app";
    expect(normalizePreviewRoot("C:\\Projects\\checkout\\gg-app\\", "win32")).toBe(expected);
    expect(normalizePreviewRoot("c:/Projects/checkout/gg-app", "win32")).toBe(expected);
    expect(normalizePreviewRoot("\\\\?\\C:\\Projects\\checkout\\gg-app", "win32")).toBe(expected);
    expect(normalizePreviewRoot("\\\\?\\UNC\\host\\share\\gg-app", "win32")).toBe("//host/share/gg-app");
    expect(normalizePreviewRoot("\\\\host\\share\\gg-app\\", "win32")).toBe("//host/share/gg-app");
    expect(normalizePreviewRoot("C:/projects/checkout/gg-app", "win32")).not.toBe(expected);
    expect(normalizePreviewRoot("/Projects/checkout/gg-app/", "linux")).toBe("/Projects/checkout/gg-app");
  });
  it("rejects a missing checkout identity before browser launch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", {
      headers: { "X-Chat-Preview": "synthetic-only-v1" },
    })));
    await expect(capturePreview()).rejects.toThrow(/checkout identity/i);
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe("isolated chat preview", () => {
  it("retains the restrictive CSP without enabling blob workers or external connections", async () => {
    const response = await previewResponse();
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:1420 ws://localhost:1420; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
    const html = await response.text();
    expect(html.indexOf('Object.defineProperty(window, "SharedWorker"')).toBeGreaterThan(-1);
    expect(html.indexOf('Object.defineProperty(window, "SharedWorker"')).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
  });
  it("requires explicit serve opt-in, never build", () => {
    expect(previewEnabled("serve", {})).toBe(false);
    expect(previewEnabled("serve", { GG_CHAT_DESIGN_PREVIEW: "true" })).toBe(false);
    expect(previewEnabled("serve", { GG_CHAT_DESIGN_PREVIEW: "1" })).toBe(true);
    expect(previewEnabled("build", { GG_CHAT_DESIGN_PREVIEW: "1" })).toBe(false);
    const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain('command === "serve" && process.env.GG_CHAT_DESIGN_PREVIEW === "1"');
    expect(readFileSync(new URL("../../src/main.tsx", import.meta.url), "utf8")).not.toContain("chat-design-preview");
  });
  it.each(layoutNames)("validates %s against the actual layout contract", (name) => {
    const layout = createLayout(name, WORKSPACE_LAYOUT_VERSION);
    const normalized = validateWorkspaceLayoutCandidate(layout);
    expect(normalized).not.toBeNull();
    let serialized = "";
    expect(saveWorkspaceLayout({ getItem: () => null, setItem: (_key, value) => { serialized = value; } }, "main", normalized!)).toBe(true);
    expect(JSON.parse(serialized)).toEqual(layout);
    expect(Object.keys(layout.panes)).toHaveLength(paneCounts[name as keyof typeof paneCounts]);
  });
  it("rejects unsupported layout and variant values", () => {
    expect(() => parsePreviewOptions("layout=../../../private")).toThrow();
    expect(() => parsePreviewOptions("variant=custom")).toThrow();
    expect(parsePreviewOptions("")).toEqual({ layout: "six", variant: "original", state: "completed" });
    expect(() => parsePreviewOptions("state=arbitrary")).toThrow();
  });
  it("provides explicit empty service defaults without a daemon port", () => {
    const responses = fixtureResponses();
    expect(responses.agent_roadmap_phase_draft_get).toEqual({ status: "ok", draft: null });
    expect(responses.qwen_cloud_connection_status.status.credential).toBe("absent");
    expect(responses.sidecar_port).toBeNull();
    expect(responses.agent_history.history[1].text).toContain("synthetic reading fixture");
  });
  it("provides explicit empty, special-message and failure fixtures", () => {
    expect(fixtureResponses("empty").agent_history.history).toEqual([]);
    expect(fixtureResponses("variants").agent_history.history.some((entry) => "command" in entry && entry.command)).toBe(true);
    expect(fixtureResponses("error").agent_history.history.some((entry) => "error" in entry && entry.error?.headline === "Synthetic provider failure")).toBe(true);
  });
  it("escapes script boundaries and serializes browser bootstrap only", () => {
    const script = fixtureScript({ responses: fixtureResponses(), marker: "</script>" });
    expect(script).not.toContain("</script>");
    expect(script).not.toContain('from "node:');
    expect(script).toContain('Object.defineProperty(window, "localStorage"');
    expect(script).toContain("Network fetch disabled");
  });
});
