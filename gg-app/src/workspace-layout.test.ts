import { describe, expect, it, vi } from "vitest";
import {
  addTerminalWorkspacePane,
  defaultWorkspaceLayout,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  preserveRejectedRecursiveWorkspaceLayout,
  recursiveWorkspaceLayoutKey,
  rejectedRecursiveWorkspaceLayoutKey,
  removeWorkspacePane,
  saveWorkspaceLayout,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  workspaceLayoutKey,
  workspaceLayoutLeafIds,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
} from "./workspace-layout";

const target = (cwd: string, sessionPath: string | null = null) => ({ cwd, sessionPath });
const agent = (cwd: string, sessionPath: string | null = null) => ({
  kind: "agent" as const,
  cwd,
  sessionPath,
});
const terminal = (cwd: string, sessionPath: string | null = null) => ({
  kind: "terminal" as const,
  cwd,
  sessionPath,
  stopped: true as const,
});
const leaf = (paneId: string): WorkspaceLayoutNode => ({ type: "leaf", paneId });
const split = (
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
  direction: "horizontal" | "vertical" = "horizontal",
  ratio = 50,
): WorkspaceLayoutNode => ({
  type: "split",
  direction,
  ratio,
  size: { type: "ratio", value: ratio },
  first,
  second,
});
const dock = (
  owner: WorkspaceLayoutNode,
  terminalLeaf: WorkspaceLayoutNode,
  pixels = 260,
): WorkspaceLayoutNode => ({
  type: "split",
  direction: "vertical",
  ratio: 50,
  size: { type: "fixed-second", pixels },
  first: owner,
  second: terminalLeaf,
});
const storedNode = (node: WorkspaceLayoutNode): unknown =>
  node.type === "leaf"
    ? node
    : {
        type: "split",
        direction: node.direction,
        size: node.size,
        first: storedNode(node.first),
        second: storedNode(node.second),
      };
const v7 = (root: WorkspaceLayoutNode, panes: Record<string, unknown>, focusedPaneId = "primary") =>
  JSON.stringify({ version: 7, root: storedNode(root), focusedPaneId, panes });
const v6 = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 6,
    root: {
      type: "split",
      direction: "horizontal",
      ratio: 50,
      first: { type: "leaf", paneId: "primary" },
      second: { type: "leaf", paneId: "secondary" },
    },
    focusedPaneId: "primary",
    panes: { primary: target("/a"), secondary: target("/b", "/session") },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
    ...overrides,
  });
const store = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
};
const canonical = (overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout => ({
  ...defaultWorkspaceLayout(),
  panes: { primary: agent("/a"), secondary: agent("/b") },
  ...overrides,
});

describe("v7 typed workspace schema", () => {
  it("uses one v7 recursive tree", () => {
    const layout = defaultWorkspaceLayout();
    expect(layout.version).toBe(7);
    expect(workspaceLayoutLeafIds(layout.root)).toEqual(["primary", "secondary"]);
  });

  it("round-trips typed agent and stopped terminal leaves", () => {
    const root = split(dock(leaf("primary"), leaf("terminal-1"), 410), leaf("secondary"));
    const parsed = parseWorkspaceLayout(
      v7(
        root,
        {
          primary: agent("/a", "/s"),
          "terminal-1": terminal("/a", "/s"),
          secondary: agent("/b"),
        },
        "terminal-1",
      ),
    );
    expect(parsed.status).toBe("valid");
    expect(parsed.layout.root).toEqual(root);
    expect(parsed.layout.focusedPaneId).toBe("terminal-1");
    expect(parsed.layout.panes["terminal-1"]).toEqual(terminal("/a", "/s"));
    expect(parsed.layout.terminal).toEqual({
      open: true,
      ownerPaneId: "primary",
      dockHeightPx: 410,
    });
  });

  it.each([
    ["missing kind", target("/a")],
    ["unknown kind", { kind: "editor", ...target("/a") }],
    ["runtime id", { ...terminal("/a"), terminalId: "native-1" }],
    ["pid", { ...terminal("/a"), pid: 1 }],
    ["output", { ...terminal("/a"), output: "secret" }],
    ["running state", { ...terminal("/a"), stopped: false }],
  ])("rejects %s in canonical descriptors", (_name, descriptor) => {
    expect(parseWorkspaceLayout(v7(leaf("primary"), { primary: descriptor })).status).toBe(
      "corrupt",
    );
  });

  it("rejects missing, extra, duplicate, invalid, and excessive leaves", () => {
    expect(parseWorkspaceLayout(v7(leaf("primary"), {})).status).toBe("corrupt");
    expect(
      parseWorkspaceLayout(v7(leaf("primary"), { primary: agent("/a"), extra: agent("/b") }))
        .status,
    ).toBe("corrupt");
    expect(
      parseWorkspaceLayout(v7(split(leaf("primary"), leaf("primary")), { primary: agent("/a") }))
        .status,
    ).toBe("corrupt");
    expect(parseWorkspaceLayout(v7(leaf("bad pane"), { "bad pane": agent("/a") })).status).toBe(
      "corrupt",
    );
    const tooMany = split(
      split(split(leaf("primary"), leaf("a")), split(leaf("b"), leaf("c"))),
      split(split(leaf("d"), leaf("e")), split(leaf("f"), split(leaf("g"), leaf("h")))),
    );
    expect(
      parseWorkspaceLayout(
        v7(
          tooMany,
          Object.fromEntries(
            ["primary", "a", "b", "c", "d", "e", "f", "g", "h"].map((id) => [id, agent(`/${id}`)]),
          ),
        ),
      ).status,
    ).toBe("corrupt");
  });

  it("allows first-class terminal leaves with their own validated target", () => {
    const parsed = parseWorkspaceLayout(
      v7(split(leaf("primary"), leaf("terminal-1")), {
        primary: agent("/a"),
        "terminal-1": terminal("/other", "/terminal-session"),
      }),
    );
    expect(parsed.status).toBe("valid");
    expect(parsed.layout.panes["terminal-1"]).toEqual(terminal("/other", "/terminal-session"));
  });

  it("clamps ratio and fixed terminal height and restores stale focus to an agent", () => {
    const raw = JSON.parse(
      v7(
        dock(leaf("primary"), leaf("terminal-1"), 50),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/a"),
        },
        "gone",
      ),
    );
    const parsed = parseWorkspaceLayout(JSON.stringify(raw));
    expect(parsed.layout.focusedPaneId).toBe("primary");
    expect((parsed.layout.root as Extract<WorkspaceLayoutNode, { type: "split" }>).size).toEqual({
      type: "fixed-second",
      pixels: 140,
    });
  });
});

describe("v6 single-dock migration", () => {
  it("converts agents and keeps a closed dock out of the tree", () => {
    const parsed = parseWorkspaceLayout(v6());
    expect(parsed.status).toBe("migrated");
    expect(workspaceLayoutLeafIds(parsed.layout.root)).toEqual(["primary", "secondary"]);
    expect(parsed.layout.panes).toEqual({
      primary: agent("/a"),
      secondary: agent("/b", "/session"),
    });
  });

  it("copies the owner target into one stopped terminal descriptor", () => {
    const parsed = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "secondary", dockHeightPx: 420 } }),
    );
    expect(workspaceLayoutLeafIds(parsed.layout.root)).toEqual([
      "primary",
      "secondary",
      "terminal-1",
    ]);
    expect(parsed.layout.panes["terminal-1"]).toEqual(terminal("/b", "/session"));
    expect(parsed.layout.focusedPaneId).toBe("primary");
    const root = parsed.layout.root as Extract<WorkspaceLayoutNode, { type: "split" }>;
    expect(root.second).toEqual(dock(leaf("secondary"), leaf("terminal-1"), 420));
  });

  it("drops an open dock whose owner is missing or unbound", () => {
    const missing = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "gone", dockHeightPx: 260 } }),
    );
    expect(missing.terminalRecovery).toEqual({ ownerPaneId: "gone", reason: "missing" });
    expect(workspaceLayoutLeafIds(missing.layout.root)).not.toContain("terminal-1");

    const unbound = parseWorkspaceLayout(
      v6({
        panes: { primary: null, secondary: target("/b") },
        terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 260 },
      }),
    );
    expect(unbound.terminalRecovery).toEqual({ ownerPaneId: "primary", reason: "unbound" });
    expect(workspaceLayoutLeafIds(unbound.layout.root)).not.toContain("terminal-1");
  });

  it("clamps migrated dock height and reports recovery", () => {
    const parsed = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 50 } }),
    );
    expect(parsed.terminalDockHeightRecovery).toEqual({ rejected: 50, resolved: 140 });
    expect(parsed.layout.terminal.dockHeightPx).toBe(140);
  });

  it("keeps v0-v5 backward reading", () => {
    for (const record of [
      { version: 0, ratio: 50, primary: { cwd: "/a" }, secondary: null },
      { version: 1, splitRatio: 50, panes: { primary: target("/a"), secondary: null } },
      {
        version: 2,
        splitRatio: 50,
        secondaryOpen: true,
        panes: { primary: target("/a"), secondary: null },
      },
      {
        version: 3,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: { primary: target("/a"), secondary: null },
      },
      {
        version: 4,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: { primary: target("/a"), secondary: null },
        terminal: { open: false, ownerPaneId: null },
      },
      {
        version: 5,
        splitRatio: 50,
        secondaryOpen: true,
        focusedPaneId: "primary",
        panes: { primary: target("/a"), secondary: null },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      },
    ]) {
      const parsed = parseWorkspaceLayout(JSON.stringify(record));
      expect(parsed.status, `v${record.version}`).toBe("migrated");
      expect(parsed.layout.version).toBe(7);
    }
  });
});

describe("v7 terminal creation reducer", () => {
  it("copies the agent target, focuses the stopped sibling, and allocates unique IDs", () => {
    const layout = canonical({
      panes: {
        primary: agent("/project", "/sessions/primary.jsonl"),
        secondary: agent("/other"),
      },
    });

    const first = addTerminalWorkspacePane(layout, "primary");
    expect(workspaceLayoutLeafIds(first.root)).toEqual(["primary", "terminal-1", "secondary"]);
    expect(first.focusedPaneId).toBe("terminal-1");
    expect(first.panes["terminal-1"]).toEqual(terminal("/project", "/sessions/primary.jsonl"));

    const second = addTerminalWorkspacePane(first, "primary");
    expect(workspaceLayoutLeafIds(second.root)).toEqual([
      "primary",
      "terminal-2",
      "terminal-1",
      "secondary",
    ]);
    expect(second.focusedPaneId).toBe("terminal-2");
    expect(second.panes["terminal-2"]).toEqual(terminal("/project", "/sessions/primary.jsonl"));
  });

  it("fails closed for unbound, terminal, and missing leaves", () => {
    const unbound = canonical({ panes: { primary: null, secondary: agent("/other") } });
    expect(addTerminalWorkspacePane(unbound, "primary")).toBe(unbound);

    const withTerminal = addTerminalWorkspacePane(canonical(), "primary");
    expect(addTerminalWorkspacePane(withTerminal, "terminal-1")).toBe(withTerminal);
    expect(addTerminalWorkspacePane(withTerminal, "missing-pane")).toBe(withTerminal);
  });
});

describe("v7 reducers", () => {
  it.each([
    ["right", "horizontal"],
    ["down", "vertical"],
  ] as const)(
    "splits a focused terminal %s into a unique stopped sibling with its target",
    (_label, direction) => {
      const parsed = parseWorkspaceLayout(
        v7(
          dock(leaf("primary"), leaf("terminal-1")),
          {
            primary: agent("/a"),
            "terminal-1": terminal("/project", "/sessions/source.jsonl"),
          },
          "terminal-1",
        ),
      ).layout;
      const layout = {
        ...parsed,
        panes: { ...parsed.panes, "terminal-2": terminal("/stale") },
      };

      const next = splitWorkspacePane(layout, "terminal-1", direction, "pane-99");

      expect(workspaceLayoutLeafIds(next.root)).toEqual(["primary", "terminal-1", "terminal-3"]);
      expect(next.focusedPaneId).toBe("terminal-3");
      expect(next.panes["terminal-3"]).toEqual(terminal("/project", "/sessions/source.jsonl"));
      const terminalSplit = (next.root as Extract<WorkspaceLayoutNode, { type: "split" }>).second;
      expect(terminalSplit).toMatchObject({ direction, size: { type: "ratio", value: 50 } });
    },
  );

  it("fails closed when a terminal descriptor has an invalid target", () => {
    const layout = parseWorkspaceLayout(
      v7(dock(leaf("primary"), leaf("terminal-1")), {
        primary: agent("/a"),
        "terminal-1": terminal("/valid"),
      }),
    ).layout;
    const malformed = {
      ...layout,
      panes: { ...layout.panes, "terminal-1": { kind: "terminal", stopped: true, cwd: "" } },
    } as unknown as WorkspaceLayout;

    expect(splitWorkspacePane(malformed, "terminal-1", "horizontal")).toBe(malformed);
  });

  it("splits an agent leaf and creates an unbound agent slot", () => {
    const layout = canonical();
    const next = splitWorkspacePane(layout, "primary", "vertical", "pane-3");
    expect(workspaceLayoutLeafIds(next.root)).toEqual(["primary", "pane-3", "secondary"]);
    expect(next.panes["pane-3"]).toBeNull();
    const withTerminal = parseWorkspaceLayout(
      v7(dock(leaf("primary"), leaf("terminal-1")), {
        primary: agent("/a"),
        "terminal-1": terminal("/a"),
      }),
    ).layout;
    expect(splitWorkspacePane(withTerminal, "missing-terminal", "horizontal")).toBe(withTerminal);
  });

  it("updates ratio splits but not fixed terminal splits", () => {
    const layout = canonical();
    expect(updateWorkspaceSplitRatio(layout, [], 80).splitRatio).toBe(80);
    const terminalLayout = parseWorkspaceLayout(
      v7(dock(leaf("primary"), leaf("terminal-1")), {
        primary: agent("/a"),
        "terminal-1": terminal("/a"),
      }),
    ).layout;
    expect(updateWorkspaceSplitRatio(terminalLayout, [], 80)).toBe(terminalLayout);
  });

  it("removes a terminal without its owner and focuses the owner", () => {
    const layout = parseWorkspaceLayout(
      v7(
        dock(leaf("primary"), leaf("terminal-1")),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/a"),
        },
        "terminal-1",
      ),
    ).layout;
    const removed = removeWorkspacePane(layout, "terminal-1");
    expect(removed.root).toEqual(leaf("primary"));
    expect(removed.focusedPaneId).toBe("primary");
    expect(removed.panes).not.toHaveProperty("terminal-1");
  });

  it("removes only the selected agent because terminals own their targets", () => {
    const root = split(
      dock(leaf("primary"), leaf("terminal-primary")),
      dock(leaf("secondary"), leaf("terminal-secondary")),
    );
    const layout = parseWorkspaceLayout(
      v7(
        root,
        {
          primary: agent("/a"),
          "terminal-primary": terminal("/a"),
          secondary: agent("/b"),
          "terminal-secondary": terminal("/b"),
        },
        "secondary",
      ),
    ).layout;
    const removed = removeWorkspacePane(layout, "secondary");
    expect(workspaceLayoutLeafIds(removed.root)).toEqual([
      "primary",
      "terminal-primary",
      "terminal-secondary",
    ]);
    expect(removed.panes).not.toHaveProperty("secondary");
    expect(removed.panes).toHaveProperty("terminal-secondary");
    expect(removed.panes).toHaveProperty("terminal-primary");
  });

  it("never removes primary", () => {
    const layout = canonical();
    expect(removeWorkspacePane(layout, "primary")).toBe(layout);
  });
});

describe("v7 storage and rollback", () => {
  it("writes canonical v7 without compatibility or runtime fields", () => {
    const { values, storage } = store();
    expect(saveWorkspaceLayout(storage, "main", canonical())).toBe(true);
    const saved = JSON.parse(values.get(recursiveWorkspaceLayoutKey("main"))!);
    expect(saved.version).toBe(7);
    expect(saved).not.toHaveProperty("terminal");
    expect(saved).not.toHaveProperty("splitRatio");
    expect(saved.panes.primary).toEqual(agent("/a"));
    expect(JSON.stringify(saved)).not.toContain("terminalId");
  });

  it("projects one terminal back to the existing v5 rollback shape", () => {
    const { values, storage } = store();
    const layout = parseWorkspaceLayout(
      v7(dock(leaf("primary"), leaf("terminal-1"), 350), {
        primary: agent("/a"),
        "terminal-1": terminal("/a"),
      }),
    ).layout;
    expect(saveWorkspaceLayout(storage, "main", layout)).toBe(true);
    expect(JSON.parse(values.get(workspaceLayoutKey("main"))!)).toMatchObject({
      version: 5,
      panes: { primary: target("/a"), secondary: null },
      terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 350 },
    });
  });

  it("leaves the last rollback snapshot untouched for multiple terminals", () => {
    const { values, storage } = store();
    values.set(workspaceLayoutKey("main"), "last-safe-v5");
    const layout = parseWorkspaceLayout(
      v7(
        split(
          dock(leaf("primary"), leaf("terminal-1")),
          dock(leaf("secondary"), leaf("terminal-2")),
        ),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/a"),
          secondary: agent("/b"),
          "terminal-2": terminal("/b"),
        },
      ),
    ).layout;
    expect(saveWorkspaceLayout(storage, "main", layout)).toBe(true);
    expect(values.get(workspaceLayoutKey("main"))).toBe("last-safe-v5");
  });

  it("reads recursive first and preserves malformed bytes exactly without legacy fallback", () => {
    const { values, storage } = store();
    const raw = ' \n{"version":99,"x":"é\\u0000"}\t';
    values.set(recursiveWorkspaceLayoutKey("main"), raw);
    values.set(workspaceLayoutKey("main"), v6());
    const loaded = loadWorkspaceLayout(storage, "main");
    expect(loaded.status).toBe("corrupt");
    expect(loaded.rejectedRaw).toBe(raw);
    expect(values.get(rejectedRecursiveWorkspaceLayoutKey("main"))).toBe(raw);
    expect(preserveRejectedRecursiveWorkspaceLayout(storage, "other", raw)).toBe(true);
  });

  it("falls back to legacy only when recursive storage is absent", () => {
    const { values, storage } = store();
    values.set(workspaceLayoutKey("main"), v6());
    expect(loadWorkspaceLayout(storage, "main").status).toBe("migrated");
  });

  it("returns false for invalid input, circular input, and storage failures", () => {
    const { storage } = store();
    const invalid = canonical({ panes: { primary: agent("/a") } });
    expect(saveWorkspaceLayout(storage, "main", invalid)).toBe(false);
    const circular = canonical();
    (circular.root as unknown as { first: unknown }).first = circular.root;
    expect(saveWorkspaceLayout(storage, "main", circular)).toBe(false);
    expect(
      saveWorkspaceLayout(
        {
          getItem: () => null,
          setItem: vi.fn(() => {
            throw new Error("quota");
          }),
        },
        "main",
        canonical(),
      ),
    ).toBe(false);
  });
});
