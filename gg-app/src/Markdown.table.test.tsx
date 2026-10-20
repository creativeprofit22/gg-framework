// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STEROIDS_COLLAPSIBLE_TABLE_MARKER } from "@kenkaiiii/gg-core/slash-command-contract";
import { classifyColumn, headerIcon, parseNumber, relativeDate } from "./markdown-table-data";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { Markdown } from "./Markdown";

afterEach(cleanup);

const TABLE = [
  "| File | Risk | Notes |",
  "|---|:---:|---|",
  "| `src/a.ts` | Low | A stuck refresh no longer holds the auth lock |",
].join("\n");

describe("markdown tables", () => {
  it("wraps each table in a keyboard-scrollable frame and keeps real table markup", () => {
    render(<Markdown>{TABLE}</Markdown>);
    const frame = screen.getByRole("region", { name: "Table" });
    expect(frame.className).toBe("md-table-scroll");
    expect(frame.tabIndex).toBe(0);
    expect(frame.querySelector(":scope > table > tbody > tr > td")).not.toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("gives sentence cells a readable width and leaves short labels natural", () => {
    render(<Markdown>{TABLE}</Markdown>);
    const notes = screen.getByRole("cell", { name: /stuck refresh/ });
    const risk = screen.getByRole("cell", { name: "Low" });
    expect(notes.className).toBe("md-cell-prose");
    expect(risk.className).toBe("");
  });

  it("lets file paths in cells wrap after slashes without changing their text", () => {
    render(<Markdown>{"| File |\n|---|\n| `packages/ggcoder/src/daemon/session.ts` |"}</Markdown>);
    const code = screen.getByRole("cell").querySelector("code");
    expect(code?.textContent).toBe("packages/ggcoder/src/daemon/session.ts");
    expect(code?.querySelectorAll("wbr")).toHaveLength(4);
  });

  it("wraps linked code paths without changing their text or link target", () => {
    const path = "packages/ggcoder/src/daemon/session-recovery.ts";
    render(<Markdown>{`| File |\n|---|\n| [\`${path}\`](${path}) |`}</Markdown>);
    const cell = screen.getByRole("cell");
    const link = cell.querySelector("a > code")?.parentElement;
    expect(link?.getAttribute("href")).toBe(path);
    expect(cell.textContent).toBe(path);
    expect(cell.querySelectorAll("a > code > wbr")).toHaveLength(4);
  });

  it("wraps bold code paths without changing their text", () => {
    const path = "packages/ggcoder/src/daemon/session.ts";
    render(<Markdown>{`| File |\n|---|\n| **\`${path}\`** |`}</Markdown>);
    const cell = screen.getByRole("cell");
    expect(cell.textContent).toBe(path);
    expect(cell.querySelectorAll("strong > code > wbr")).toHaveLength(4);
  });

  it("wraps bare paths without changing their text", () => {
    const path = "packages/ggcoder/src/daemon/session.ts";
    render(<Markdown>{`| File |\n|---|\n| ${path} |`}</Markdown>);
    const cell = screen.getByRole("cell");
    expect(cell.textContent).toBe(path);
    expect(cell.querySelectorAll("wbr")).toHaveLength(4);
  });

  it("wraps bare paths in the streaming word spans", () => {
    const path = "packages/ggcoder/src/daemon/session.ts";
    render(<Markdown animate>{`| File |\n|---|\n| ${path} |`}</Markdown>);
    const cell = screen.getByRole("cell");
    expect(cell.textContent).toBe(path);
    expect(cell.querySelectorAll("wbr")).toHaveLength(4);
  });

  it("keeps GFM column alignment", () => {
    render(<Markdown>{TABLE}</Markdown>);
    expect(screen.getByRole("cell", { name: "Low" }).style.textAlign).toBe("center");
  });
});

const REPOS = [
  "| # | Repo | Stars | Last push | Why it fits |",
  "|---|---|---|---|---|",
  "| 1 | [vitejs/vite](https://github.com/vitejs/vite) | 71.2k | 2026-10-18 | Same toolchain |",
  "| 2 | [pmndrs/zustand](https://github.com/pmndrs/zustand) | 52.0k | 2026-03-01 | |",
  "| 3 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 92.4k | 2026-10-12 | Upstream shell |",
].join("\n");

function columnText(table: HTMLElement, column: number): string[] {
  return [...table.querySelectorAll("tbody tr")].map(
    (row) => row.querySelectorAll("td")[column]?.textContent ?? "",
  );
}

describe("data-aware markdown tables", () => {
  it("types columns from their cells: quiet rank, right-aligned figures, unbroken dates", () => {
    render(<Markdown>{REPOS}</Markdown>);
    const [rank, repo, stars, pushed] = screen.getAllByRole("columnheader");
    expect(rank?.className).toBe("md-col-rank");
    expect(repo?.className).toBe("");
    expect(stars?.className).toBe("md-col-num");
    expect(pushed?.className).toBe("md-col-date");
    const firstStars = screen.getAllByRole("cell")[2];
    expect(firstStars?.className).toBe("md-col-num");
    expect(firstStars?.dataset.label).toBe("Stars");
    // Four or more columns stack into cards in narrow panes.
    expect(screen.getByRole("table").className).toBe("md-table-cards");
    expect(render(<Markdown>{TABLE}</Markdown>).container.querySelector("table")?.className).toBe(
      "",
    );
  });

  it("marks empty cells and turns GitHub repo links into an owner line over a bold name", () => {
    render(<Markdown>{REPOS}</Markdown>);
    const empty = screen.getAllByRole("cell").find((cell) => cell.textContent === "");
    expect(empty?.className).toContain("md-cell-empty");
    // The link's text and target are unchanged; no tile or icon is added.
    const link = screen.getByRole("link", { name: "vitejs/vite" });
    expect(link.getAttribute("href")).toBe("https://github.com/vitejs/vite");
    expect(link.textContent).toBe("vitejs/vite");
    expect(link.querySelector(".md-repo-tile")).toBeNull();
    expect(link.querySelector(".md-repo-owner")?.textContent).toBe("vitejs/");
    expect(link.querySelector(".md-repo-name")?.textContent).toBe("vite");
    // Ranks become badges; the top three are lit.
    const badges = [...document.querySelectorAll(".md-rank")];
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2", "3"]);
    expect(badges[0]?.getAttribute("data-rank")).toBe("1");
  });

  it("splits other paths into muted folders and a bold name, but leaves prose alone", () => {
    render(<Markdown>{"| File | Note |\n|---|---|\n| src/app/main.ts | and/or |"}</Markdown>);
    const file = screen.getByRole("cell", { name: "src/app/main.ts" });
    expect([...file.querySelectorAll(".md-path-seg")].map((seg) => seg.textContent)).toEqual([
      "src/",
      "app/",
    ]);
    expect(file.querySelector(".md-path-name")?.textContent).toBe("main.ts");
    // A link whose text isn't its repo's owner/name stays an ordinary link.
    render(<Markdown>{"| Repo |\n|---|\n| [Vite](https://github.com/vitejs/vite) |"}</Markdown>);
    expect(screen.getByRole("link", { name: "Vite" }).querySelector(".md-repo")).toBeNull();
    expect(screen.getByRole("cell", { name: "and/or" }).querySelector(".md-path")).toBeNull();
  });

  it("sorts by a header click: figures biggest first, then reversed, then the reply's order", () => {
    render(<Markdown>{REPOS}</Markdown>);
    const table = screen.getByRole("table");
    const stars = screen.getByRole("button", { name: "Stars" });
    fireEvent.click(stars);
    expect(columnText(table, 2)).toEqual(["92.4k", "71.2k", "52.0k"]);
    expect(stars.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(stars);
    expect(columnText(table, 2)).toEqual(["52.0k", "71.2k", "92.4k"]);
    expect(stars.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(stars);
    expect(columnText(table, 2)).toEqual(["71.2k", "52.0k", "92.4k"]);
    expect(stars.closest("th")?.hasAttribute("aria-sort")).toBe(false);
    // Text sorts A→Z first; empty cells always sink to the bottom.
    fireEvent.click(screen.getByRole("button", { name: "Why it fits" }));
    expect(columnText(table, 4)).toEqual(["Same toolchain", "Upstream shell", ""]);
  });

  it("leads known headers with a decorative column icon and leaves unknown ones plain", () => {
    render(<Markdown>{REPOS}</Markdown>);
    const icons = screen
      .getAllByRole("columnheader")
      .map((th) => th.querySelector(".md-th-icon")?.getAttribute("data-icon") ?? null);
    // The "#" header already is the glyph, so it gets no second one.
    expect(icons).toEqual([null, "repo", "star", "time", "fit"]);
    const icon = screen.getAllByRole("columnheader")[2]?.querySelector(".md-th-icon");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    // The icon is decorative: the sort button's name is still just the label.
    expect(screen.getByRole("button", { name: "Stars" })).toBeTruthy();
    render(<Markdown>{"| Colour | Mood |\n|---|---|\n| red | warm |"}</Markdown>);
    expect(screen.getByRole("columnheader", { name: "Colour" }).querySelector("svg")).toBeNull();
  });

  it("leaves short tables unsorted", () => {
    render(<Markdown>{TABLE}</Markdown>);
    expect(screen.queryByRole("button", { name: "File" })).toBeNull();
  });

  it("copies the table as Markdown with links kept, or as formula-safe CSV", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <Markdown>
        {'| Name | Note |\n|:---|---:|\n| [a/b](https://x.dev/a) | =SUM(1), "x" |\n| `c` | |'}
      </Markdown>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(
      [
        "| Name | Note |",
        "| :--- | ---: |",
        '| [a/b](https://x.dev/a) | =SUM(1), "x" |',
        "| `c` |  |",
      ].join("\n"),
    );
    expect(await screen.findByRole("button", { name: "Copied table as Markdown" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy table as CSV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(
      ["Name,Note", `a/b,"'=SUM(1), ""x"""`, "c,"].join("\n"),
    );
  });
});

describe("/steroids table extras", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows star bars scaled to the top repo and last pushes as fresh or stale relative dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T09:00:00Z"));
    const { container } = render(
      <Markdown>{`${STEROIDS_COLLAPSIBLE_TABLE_MARKER}\n\n${REPOS}`}</Markdown>,
    );
    const fills = [...container.querySelectorAll<HTMLElement>(".md-meter-fill")];
    expect(fills.map((fill) => fill.style.width)).toEqual(["77.1%", "56.3%", "100%"]);
    const dates = [...container.querySelectorAll("time")];
    expect(dates.map((date) => date.textContent)).toEqual([
      "2 days ago",
      "7 months ago",
      "last week",
    ]);
    expect(dates.map((date) => date.className)).toEqual([
      "md-date md-date-fresh",
      "md-date md-date-stale",
      "md-date md-date-fresh",
    ]);
    expect(dates[0]?.getAttribute("dateTime")).toBe("2026-10-18");
    expect(dates[0]?.getAttribute("title")).toBe("2026-10-18");
  });

  it("keeps bars and relative dates out of ordinary tables", () => {
    const { container } = render(<Markdown>{REPOS}</Markdown>);
    expect(container.querySelector(".md-meter, time")).toBeNull();
  });
});

describe("table data helpers", () => {
  it("reads numbers with units and suffixes, and classifies ids", () => {
    expect(parseNumber("71.2k")).toBe(71_200);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("−3.5%")).toBe(-3.5);
    expect(parseNumber("12 MB")).toBe(12_000_000);
    expect(parseNumber("v1.2")).toBeNull();
    expect(classifyColumn("Version", ["v1.2.3", "2.0.0-rc.1"], 1)).toBe("id");
    expect(classifyColumn("Commit", ["a1b2c3d", "deadbeef01"], 1)).toBe("id");
    expect(classifyColumn("Count", ["1", "2"], 1)).toBe("num");
    expect(classifyColumn("Step", ["3", "1"], 0)).toBe("num");
    expect(classifyColumn("#", ["3", "1"], 0)).toBe("rank");
  });

  it("picks header icons from the label first, then the column's data", () => {
    expect(headerIcon("GitHub stars", "num")).toBe("star");
    expect(headerIcon("Last push", "date")).toBe("time");
    expect(headerIcon("Shipped", "date")).toBe("time");
    // Fit columns get the puzzle piece; generic why/reason columns the lightbulb.
    expect(headerIcon("Why it fits", "text")).toBe("fit");
    expect(headerIcon("Relevance", "text")).toBe("fit");
    expect(headerIcon("Why", "text")).toBe("reason");
    expect(headerIcon("Reasons", "text")).toBe("reason");
    expect(headerIcon("Rationale", "text")).toBe("reason");
    expect(headerIcon("File", "text")).toBe("file");
    expect(headerIcon("Build", "id")).toBe("version");
    expect(headerIcon("", "rank")).toBe("rank");
    expect(headerIcon("Rank", "rank")).toBe("rank");
    expect(headerIcon("#", "rank")).toBeNull();
    expect(headerIcon("Colour", "text")).toBeNull();
    expect(headerIcon("Count", "num")).toBeNull();
  });

  it("formats relative dates in whole UTC days and never into the future", () => {
    const now = Date.parse("2026-10-20T23:30:00Z");
    expect(relativeDate("2026-10-20", now)).toEqual({ label: "today", freshness: "fresh" });
    expect(relativeDate("2026-10-19", now)?.label).toBe("yesterday");
    expect(relativeDate("2026-10-25", now)?.label).toBe("today");
    expect(relativeDate("2025-07-01", now)).toEqual({ label: "last year", freshness: "stale" });
    expect(relativeDate("Oct 18", now)).toBeNull();
  });
});
