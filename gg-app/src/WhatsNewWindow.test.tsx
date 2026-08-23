// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import { WHATS_NEW_STORAGE_KEY } from "./whats-new";
import { releaseText, WhatsNewWindow } from "./WhatsNewWindow";

const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ close }),
}));
vi.mock("./Confetti", () => ({ Confetti: () => null }));

function setSeen(local: string, upstream: string): void {
  localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ local, upstream }));
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  close.mockClear();
});

describe("releaseText", () => {
  it("renders explicit and known specifics as themed inline highlights", () => {
    const html = renderToStaticMarkup(
      <>{releaseText("Turn on `Autopilot` for GPT-5.6 and save 90 MB.")}</>,
    );

    expect(html).not.toContain("`");
    expect(html.match(/class="whatsnew-highlight"/g)).toHaveLength(3);
    expect(html).toContain(">Autopilot</strong>");
    expect(html).toContain(">GPT-5.6</strong>");
    expect(html).toContain(">90 MB</strong>");
  });
});

describe("WhatsNewWindow", () => {
  it("isolates Local Fork and Upstream content in associated tab panels", () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    render(<WhatsNewWindow localPatched storage={localStorage} />);

    const localTab = screen.getByRole("tab", { name: "Local Fork" });
    const upstreamTab = screen.getByRole("tab", { name: "Upstream" });
    const localPanel = document.getElementById(localTab.getAttribute("aria-controls")!)!;
    const upstreamPanel = document.getElementById(upstreamTab.getAttribute("aria-controls")!)!;

    expect(localTab.getAttribute("aria-selected")).toBe("true");
    expect(localTab.getAttribute("aria-controls")).toBe(localPanel.id);
    expect(localPanel.getAttribute("aria-labelledby")).toBe(localTab.id);
    expect(within(localPanel).getByText(/Local updates now guard/)).toBeTruthy();
    expect(upstreamPanel.hidden).toBe(true);
    fireEvent.click(upstreamTab);
    expect(localPanel.hidden).toBe(true);
    expect(upstreamPanel.hidden).toBe(false);
    expect(upstreamPanel.textContent).toContain(CHANGELOG[0].items[0].replace(/`/g, ""));
  });

  it("selects unread Local Fork first and marks feeds independently", () => {
    setSeen(LOCAL_CHANGELOG[1].id, CHANGELOG[1].version);
    render(<WhatsNewWindow localPatched storage={localStorage} />);

    const localTab = screen.getByRole("tab", { name: "Local Fork" });
    const upstreamTab = screen.getByRole("tab", { name: /Upstream.*unread/ });
    expect(localTab.getAttribute("aria-selected")).toBe("true");
    expect(JSON.parse(localStorage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      local: LOCAL_CHANGELOG[0].id,
      upstream: CHANGELOG[1].version,
    });

    fireEvent.click(upstreamTab);
    expect(JSON.parse(localStorage.getItem(WHATS_NEW_STORAGE_KEY)!)).toEqual({
      local: LOCAL_CHANGELOG[0].id,
      upstream: CHANGELOG[0].version,
    });
  });

  it("activates tabs with click, Arrow keys, Home, and End using roving focus", () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    render(<WhatsNewWindow localPatched storage={localStorage} />);
    const localTab = screen.getByRole("tab", { name: "Local Fork" });
    const upstreamTab = screen.getByRole("tab", { name: "Upstream" });

    fireEvent.keyDown(localTab, { key: "ArrowRight" });
    expect(upstreamTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(upstreamTab);

    fireEvent.keyDown(upstreamTab, { key: "Home" });
    expect(localTab.getAttribute("aria-selected")).toBe("true");
    expect(localTab.tabIndex).toBe(0);
    expect(upstreamTab.tabIndex).toBe(-1);

    fireEvent.keyDown(localTab, { key: "End" });
    expect(upstreamTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(upstreamTab, { key: "ArrowLeft" });
    expect(localTab.getAttribute("aria-selected")).toBe("true");
  });

  it("features one latest release before grouped history", () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    const { container } = render(<WhatsNewWindow localPatched storage={localStorage} />);
    const activePanel = container.querySelector<HTMLElement>(".whatsnew-panel:not([hidden])")!;

    expect(activePanel.querySelectorAll(".whatsnew-section.latest")).toHaveLength(1);
    expect(activePanel.textContent!.indexOf("Previous updates")).toBeGreaterThan(
      activePanel.textContent!.indexOf("Latest"),
    );
  });

  it("renders only Upstream without a redundant tablist in official builds", () => {
    render(<WhatsNewWindow localPatched={false} storage={localStorage} />);

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Upstream")).toBeTruthy();
    expect(screen.queryByText("Local Fork")).toBeNull();
    expect(document.body.textContent).toContain(CHANGELOG[0].items[0].replace(/`/g, ""));
  });
});
