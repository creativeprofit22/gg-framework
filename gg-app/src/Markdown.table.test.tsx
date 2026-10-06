// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

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
