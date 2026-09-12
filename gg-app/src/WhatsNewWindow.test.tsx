// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type * as AgentModule from "./agent";
import { CHANGELOG } from "./changelog";
import { LOCAL_CHANGELOG } from "./local-changelog";
import localReleaseNotes from "./local-release-notes.json";
import { WHATS_NEW_STORAGE_KEY } from "./whats-new-status";
import { releaseText, WhatsNewWindow } from "./WhatsNewWindow";

const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Native focus events and IPC are mocked; these tests do not launch a Tauri window.
const focus = vi.hoisted(() => ({
  handler: undefined as (() => void) | undefined,
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ close, listen: focus.listen }),
}));
vi.mock("./Confetti", () => ({ Confetti: () => null }));
vi.mock("./agent", () => ({ getVerifiedDecisions: vi.fn(async () => []) }));

function setSeen(local: string, upstream: string): void {
  localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ local, upstream }));
}

function verifiedDecisionRecords(checks: "passed" | "not-recorded" = "not-recorded") {
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
        checks,
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
  focus.handler = undefined;
  focus.unlisten.mockReset();
  focus.listen.mockReset().mockImplementation(async (event: string, handler: () => void) => {
    expect(event).toBe("tauri://focus");
    focus.handler = handler;
    return focus.unlisten;
  });
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
    expect(
      within(localPanel.querySelector(".latest")!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(
      localReleaseNotes.sections.flatMap(({ items }) =>
        items.map((item) => item.replace(/`/g, "")),
      ),
    );
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

  it.each(["passed", "not-recorded"] as const)(
    "renders the stored summary for %s checks",
    async (checks) => {
      setSeen(LOCAL_CHANGELOG[0].id, CHANGELOG[0].version);
      const loadDecisions = vi.fn(async () => verifiedDecisionRecords(checks));
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
    },
  );

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
      "New reliability fixes, same Local Fork. Your workspace, Roadmap, and session recovery stay in place while upstream improvements come in. No need to trade away your setup.",
    );
    const panel = summary.closest<HTMLElement>("[role='tabpanel']")!;
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    expect(panel.textContent).not.toContain(historicalRecord.summary.text);
    expect(panel.textContent).not.toContain("decision-89af62bbd76e");
    expect(panel.textContent).not.toContain("gg-app/src/WhatsNewWindow.tsx");
    expect(panel.textContent).not.toContain("workflowVerified");
    expect(panel.textContent).not.toContain("a".repeat(40));
  });

  it("preserves native chronology and the freshest summary through the bridge to Latest", async () => {
    const { getVerifiedDecisions } = await vi.importActual<typeof AgentModule>("./agent");
    const base = verifiedDecisionRecords()[0];
    const records = [
      {
        ...base,
        id: "decision-f",
        evidence: { ...base.evidence, merge: "f".repeat(40) },
        verification: { ...base.verification, recordedAt: "2026-08-24T11:00:00Z" },
        summary: {
          ...base.summary,
          text: "Your latest protected update keeps your settings and includes the newest improvements.",
        },
      },
      {
        ...base,
        id: "decision-a",
        verification: { ...base.verification, recordedAt: "2026-08-24T12:00:00+02:00" },
      },
    ];
    // Native loading owns ordering and duplicate suppression; IPC must preserve its result.
    invoke.mockResolvedValue(records);
    await expect(getVerifiedDecisions("C:/source")).resolves.toEqual(records);
    render(
      <WhatsNewWindow
        localPatched
        sourceRoot="C:/source"
        storage={localStorage}
        loadDecisions={getVerifiedDecisions}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    const summary = await screen.findByText(records[0].summary.text);
    const panel = summary.closest<HTMLElement>("[role='tabpanel']")!;
    const sections = panel.querySelectorAll(".whatsnew-section");
    expect(sections).toHaveLength(2);
    expect(sections[0].classList.contains("latest")).toBe(true);
    expect(within(sections[0] as HTMLElement).getByText("Latest")).toBeTruthy();
    expect(sections[0].textContent).toContain(records[0].summary.text);
    expect(sections[1].textContent).toContain(records[1].summary.text);
    expect(within(panel).getAllByText("Latest")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("app_verified_decisions", { repoRoot: "C:/source" });
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

  it.each(["skipped", "failed", "pending", "running"])(
    "does not render readiness for %s checks through the real bridge",
    async (checks) => {
      const { getVerifiedDecisions } = await vi.importActual<typeof AgentModule>("./agent");
      const record = verifiedDecisionRecords()[0];
      invoke.mockResolvedValue([{ ...record, verification: { ...record.verification, checks } }]);
      const loadDecisions = vi.fn(getVerifiedDecisions);
      render(
        <WhatsNewWindow
          localPatched
          sourceRoot="C:/source"
          storage={localStorage}
          loadDecisions={loadDecisions}
        />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
      await waitFor(() => expect(loadDecisions).toHaveBeenCalled());
      await expect(loadDecisions.mock.results[0].value).rejects.toThrow(
        "invalid decisions response",
      );
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "We couldn’t load verified decisions. Please try again.",
      );
      expect(screen.queryByText("No verified decisions yet.")).toBeNull();
      expect(screen.queryByText("Protected update")).toBeNull();
      expect(screen.queryByText(/Your protected update is ready/)).toBeNull();
    },
  );

  it("shows loading rather than empty history while pending", () => {
    const loadDecisions = vi.fn(
      () => new Promise<ReturnType<typeof verifiedDecisionRecords>>(() => {}),
    );
    render(<WhatsNewWindow localPatched loadDecisions={loadDecisions} />);
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    expect(screen.getByRole("status").textContent).toBe("Loading verified decisions…");
    expect(screen.queryByText("No verified decisions yet.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows empty history only after a successful empty load", async () => {
    render(<WhatsNewWindow localPatched loadDecisions={async () => []} />);
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    expect(await screen.findByText("No verified decisions yet.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a safe failure and retries the same loader to recover records", async () => {
    let recover!: (records: ReturnType<typeof verifiedDecisionRecords>) => void;
    const loadDecisions = vi
      .fn<(root: string) => Promise<ReturnType<typeof verifiedDecisionRecords>>>()
      .mockRejectedValueOnce(new Error("Could not find C:/private/source: native worker failed"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            recover = resolve;
          }),
      );
    render(<WhatsNewWindow localPatched sourceRoot="C:/source" loadDecisions={loadDecisions} />);
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "We couldn’t load verified decisions. Please try again.",
    );
    expect(document.body.textContent).not.toContain("C:/private/source");
    expect(document.body.textContent).not.toContain("native worker failed");
    expect(screen.queryByText("No verified decisions yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadDecisions.mock.calls).toEqual([["C:/source"], ["C:/source"]]);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => recover(verifiedDecisionRecords()));
    expect(screen.getByText("Protected update")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("No verified decisions yet.")).toBeNull();
  });

  it("clears previous records when a changed source loads an empty history", async () => {
    const loadDecisions = vi
      .fn()
      .mockResolvedValueOnce(verifiedDecisionRecords())
      .mockResolvedValueOnce([]);
    const { rerender } = render(
      <WhatsNewWindow localPatched sourceRoot="old" loadDecisions={loadDecisions} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    await screen.findByText("Protected update");
    rerender(<WhatsNewWindow localPatched sourceRoot="new" loadDecisions={loadDecisions} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Protected update")).toBeNull();
    expect(await screen.findByText("No verified decisions yet.")).toBeTruthy();
    expect(loadDecisions.mock.calls).toEqual([["old"], ["new"]]);
  });

  it.each(["records", "empty", "rejection"])(
    "ignores obsolete %s after a newer source finishes",
    async (result) => {
      let resolveOld!: (records: ReturnType<typeof verifiedDecisionRecords>) => void;
      let rejectOld!: (error: Error) => void;
      const oldLoad = new Promise<ReturnType<typeof verifiedDecisionRecords>>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const newerRecords = [
        {
          ...verifiedDecisionRecords()[0],
          summary: {
            ...verifiedDecisionRecords()[0].summary,
            text: "Your newer protected update keeps your settings and includes the latest improvements.",
          },
        },
      ];
      const loadDecisions = vi
        .fn()
        .mockReturnValueOnce(oldLoad)
        .mockResolvedValueOnce(newerRecords);
      const { rerender } = render(
        <WhatsNewWindow localPatched sourceRoot="old" loadDecisions={loadDecisions} />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
      rerender(<WhatsNewWindow localPatched sourceRoot="new" loadDecisions={loadDecisions} />);
      await screen.findByText(newerRecords[0].summary.text);
      await act(async () => {
        if (result === "rejection") rejectOld(new Error("obsolete failure"));
        else resolveOld(result === "empty" ? [] : verifiedDecisionRecords());
      });
      expect(screen.getByText(newerRecords[0].summary.text)).toBeTruthy();
      expect(screen.queryByText(verifiedDecisionRecords()[0].summary.text)).toBeNull();
      expect(screen.queryByText("No verified decisions yet.")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each(["new record", "same ID summary", "empty"])(
    "refreshes %s on native refocus without changing props or loader",
    async (change) => {
      const before = verifiedDecisionRecords();
      const after =
        change === "empty"
          ? []
          : [
              {
                ...before[0],
                id: change === "new record" ? "decision-new" : before[0].id,
                summary: {
                  ...before[0].summary,
                  text: "Your refreshed protected update keeps your settings intact.",
                },
              },
            ];
      const loadDecisions = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      render(<WhatsNewWindow localPatched sourceRoot="C:/source" loadDecisions={loadDecisions} />);
      fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
      await screen.findByText(before[0].summary.text);
      act(() => focus.handler?.());
      await screen.findByText(after[0]?.summary.text ?? "No verified decisions yet.");
      expect(screen.queryByText(before[0].summary.text)).toBeNull();
      expect(loadDecisions.mock.calls).toEqual([["C:/source"], ["C:/source"]]);
    },
  );

  it.each(["records", "empty", "rejection"])(
    "ignores out-of-order %s after refocus loads newer decisions",
    async (result) => {
      let resolveOld!: (records: ReturnType<typeof verifiedDecisionRecords>) => void;
      let rejectOld!: (error: Error) => void;
      const oldLoad = new Promise<ReturnType<typeof verifiedDecisionRecords>>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const newer = verifiedDecisionRecords();
      newer[0].summary.text = "Your newest protected update preserves your custom settings.";
      const loadDecisions = vi.fn().mockReturnValueOnce(oldLoad).mockResolvedValueOnce(newer);
      render(<WhatsNewWindow localPatched loadDecisions={loadDecisions} />);
      fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
      act(() => focus.handler?.());
      await screen.findByText(newer[0].summary.text);
      await act(async () => {
        if (result === "rejection") rejectOld(new Error("obsolete failure"));
        else resolveOld(result === "empty" ? [] : verifiedDecisionRecords());
      });
      expect(screen.getByText(newer[0].summary.text)).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each([false, true])("cleans up native focus registration (delayed=%s)", async (delayed) => {
    let registered!: (unlisten: () => void) => void;
    if (delayed) {
      focus.listen.mockImplementationOnce((_event: string, handler: () => void) => {
        focus.handler = handler;
        return new Promise<() => void>((resolve) => {
          registered = resolve;
        });
      });
    }
    const loadDecisions = vi.fn(async () => verifiedDecisionRecords());
    const { unmount } = render(<WhatsNewWindow localPatched loadDecisions={loadDecisions} />);
    await act(async () => {});
    unmount();
    if (delayed) await act(async () => registered(focus.unlisten));
    expect(focus.unlisten).toHaveBeenCalledOnce();
    act(() => focus.handler?.());
    expect(loadDecisions).toHaveBeenCalledOnce();
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
