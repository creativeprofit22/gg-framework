// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import localReleaseNotes from "./local-release-notes.json";
import { WHATS_NEW_STORAGE_KEY } from "./whats-new";
import { releaseText, WhatsNewWindow } from "./WhatsNewWindow";

const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ close }),
}));
vi.mock("./Confetti", () => ({ Confetti: () => null }));
vi.mock("./agent", () => ({ getVerifiedDecisions: vi.fn(async () => []) }));

function setSeen(local: string, upstream: string): void {
  localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ local, upstream }));
}

function verifiedDecisionRecords() {
  const blobs = {
    base: "1".repeat(40),
    local: "2".repeat(40),
    upstream: "3".repeat(40),
    merged: "4".repeat(40),
  };
  return [
    {
      schemaVersion: 2,
      id: "decision-abc",
      date: "2026-08-24",
      label: "Merge upstream internals",
      evidence: {
        merge: "a".repeat(40),
        base: "b".repeat(40),
        localParent: "c".repeat(40),
        upstreamParent: "d".repeat(40),
      },
      summary: {
        text: "Your custom provider setup stays exactly how you like it because it keeps fork-specific sessions separate. You still get upstream's clearer recovery guidance, so updates are easier to follow without giving up your setup.",
        source: "agent" as const,
        generatedAt: "2026-08-24T10:00:15.000Z",
      },
      verification: {
        workflowVerified: true as const,
        phase: "verified",
        recordedAt: "2026-08-24T10:00:00.000Z",
        checks: "not-recorded",
        installer: null,
      },
      decisions: [
        {
          area: "gg-app/src/LocalSettings",
          outcome: "kept-local" as const,
          files: [
            {
              path: "gg-app/src/LocalSettings.tsx",
              role: "implementation",
              outcome: "kept-local",
              blobs,
            },
          ],
        },
        {
          area: "gg-app/src/UpstreamSettings",
          outcome: "adopted-upstream" as const,
          files: [
            {
              path: "gg-app/src/UpstreamSettings.tsx",
              role: "implementation",
              outcome: "adopted-upstream",
              blobs,
            },
          ],
        },
        {
          area: "gg-app/src/WhatsNewWindow",
          outcome: "combined" as const,
          files: [
            {
              path: "gg-app/src/WhatsNewWindow.tsx",
              role: "implementation",
              outcome: "combined",
              blobs,
            },
          ],
        },
        {
          area: "gg-app/src/UnknownSettings",
          outcome: "unresolved" as const,
          files: [
            {
              path: "gg-app/src/UnknownSettings.tsx",
              role: "implementation",
              outcome: "unresolved",
              blobs,
            },
          ],
        },
      ],
    },
  ];
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
    expect(within(localPanel).getByText(localReleaseNotes.label)).toBeTruthy();
    for (const item of localReleaseNotes.sections.flatMap(({ items }) => items)) {
      expect(within(localPanel).getByText(item)).toBeTruthy();
    }
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

  it("activates three tabs with Arrow keys, Home, and End using roving focus", () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    render(<WhatsNewWindow localPatched storage={localStorage} />);
    const localTab = screen.getByRole("tab", { name: "Local Fork" });
    const upstreamTab = screen.getByRole("tab", { name: "Upstream" });
    const decisionsTab = screen.getByRole("tab", { name: "Decisions" });

    fireEvent.keyDown(localTab, { key: "ArrowRight" });
    expect(upstreamTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(upstreamTab);

    fireEvent.keyDown(upstreamTab, { key: "ArrowLeft" });
    expect(localTab.getAttribute("aria-selected")).toBe("true");
    expect(localTab.tabIndex).toBe(0);
    expect(upstreamTab.tabIndex).toBe(-1);

    fireEvent.keyDown(localTab, { key: "End" });
    expect(decisionsTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(decisionsTab, { key: "Home" });
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

  it("renders one shared section with exactly one cohesive stored summary", async () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    const loadDecisions = vi.fn(async () => verifiedDecisionRecords());
    render(
      <WhatsNewWindow
        localPatched
        sourceRoot="C:/source"
        storage={localStorage}
        loadDecisions={loadDecisions}
      />,
    );

    const decisionsTab = screen.getByRole("tab", { name: "Decisions" });
    fireEvent.click(decisionsTab);
    await waitFor(() => expect(screen.getByText("Protected update")).toBeTruthy());
    expect(loadDecisions).toHaveBeenCalledWith("C:/source");
    const panel = document.getElementById(decisionsTab.getAttribute("aria-controls")!)!;
    const sections = panel.querySelectorAll(".whatsnew-section");
    expect(sections).toHaveLength(1);
    expect(
      Array.from(sections[0].querySelectorAll(".whatsnew-item"), (item) => item.textContent),
    ).toEqual([
      "Your custom provider setup stays exactly how you like it because it keeps fork-specific sessions separate. You still get upstream's clearer recovery guidance, so updates are easier to follow without giving up your setup.",
    ]);
    expect(within(panel).getByText("Latest")).toBeTruthy();
    expect(within(panel).getByText("2026-08-24")).toBeTruthy();
  });

  it("replaces only the historical fallback summary with plain-language copy", async () => {
    const historicalRecord = {
      ...verifiedDecisionRecords()[0],
      id: "decision-89af62bbd76e",
      summary: {
        text: "Your protected update is ready. It held onto your local work in one area because the finished update uses your version there. It blended your work with upstream in 7 areas, keeping changes from both sides.",
        source: "fallback" as const,
        generatedAt: "2026-08-24T10:00:15.000Z",
      },
    };
    render(
      <WhatsNewWindow
        localPatched
        storage={localStorage}
        loadDecisions={async () => [historicalRecord]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    const summary = await screen.findByText(
      "Your update kept your Local Fork’s projects, workspace, Roadmap, session recovery, sign-ins, and connected tools working as before. It also added safer file handling, clearer results when a tool’s outcome is uncertain, better recovery after interruptions, steadier conversations while typing, and simpler settings. This protected your setup while bringing in the latest reliability improvements. You can keep working normally and safely continue your existing projects and sessions.",
    );
    const panel = summary.closest<HTMLElement>("[role='tabpanel']")!;
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    expect(panel.textContent).not.toContain(historicalRecord.summary.text);
    expect(panel.textContent).not.toContain("decision-89af62bbd76e");
    expect(panel.textContent).not.toContain("gg-app/src/WhatsNewWindow.tsx");
    expect(panel.textContent).not.toContain("workflowVerified");
    expect(panel.textContent).not.toContain("a".repeat(40));
  });

  it("renders ordinary fallback text exactly without a provenance badge", async () => {
    const fallbackRecord = {
      ...verifiedDecisionRecords()[0],
      summary: {
        text: "Your protected update is ready. It blended your work with upstream in one area, keeping changes from both sides.",
        source: "fallback" as const,
        generatedAt: "2026-08-24T10:00:15.000Z",
      },
    };
    render(
      <WhatsNewWindow
        localPatched
        storage={localStorage}
        loadDecisions={async () => [fallbackRecord]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    const summary = await screen.findByText(
      "Your protected update is ready. It blended your work with upstream in one area, keeping changes from both sides.",
    );
    const panel = summary.closest<HTMLElement>("[role='tabpanel']")!;
    expect(within(panel).queryByText("fallback")).toBeNull();
    expect(within(panel).queryByText("agent")).toBeNull();
  });

  it("keeps technical decision evidence out of the rendered feed", async () => {
    setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
    render(
      <WhatsNewWindow
        localPatched
        storage={localStorage}
        loadDecisions={async () => verifiedDecisionRecords()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    await waitFor(() => expect(screen.getByText("Protected update")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("gg-app/src/WhatsNewWindow.tsx");
    expect(text).not.toContain("a".repeat(40));
    expect(text).not.toContain("b".repeat(40));
    expect(text).not.toContain("workflowVerified");
    expect(text).not.toContain("Reason unavailable");
    expect(text).not.toContain("Merge upstream internals");
  });

  it.each([
    ["empty", async () => []],
    ["failed", async () => Promise.reject(new Error("unavailable"))],
  ])("shows the honest empty state after an %s Decisions load", async (_state, loader) => {
    const loadDecisions = vi.fn(loader);
    render(<WhatsNewWindow localPatched storage={localStorage} loadDecisions={loadDecisions} />);
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    await waitFor(() => expect(loadDecisions).toHaveBeenCalled());
    expect(screen.getByText("No verified decisions yet.")).toBeTruthy();
  });

  it("renders and loads only Upstream in official builds", () => {
    const loadDecisions = vi.fn(async () => verifiedDecisionRecords());
    render(
      <WhatsNewWindow localPatched={false} storage={localStorage} loadDecisions={loadDecisions} />,
    );

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Upstream")).toBeTruthy();
    expect(screen.queryByText("Local Fork")).toBeNull();
    expect(screen.queryByText("Decisions")).toBeNull();
    expect(loadDecisions).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(CHANGELOG[0].items[0].replace(/`/g, ""));
  });
});
