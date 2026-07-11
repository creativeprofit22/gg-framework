import { describe, expect, it, vi } from "vitest";
import {
  defaultWorkspaceLayout,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  preserveRejectedRecursiveWorkspaceLayout,
  recursiveWorkspaceLayoutKey,
  rejectedRecursiveWorkspaceLayoutKey,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  workspaceLayoutKey,
  workspaceLayoutLeafIds,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
} from "./workspace-layout";

const target = (cwd: string, sessionPath: string | null = null) => ({ cwd, sessionPath });
const leaf = (paneId: string): WorkspaceLayoutNode => ({ type: "leaf", paneId });
const split = (
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
  direction: "horizontal" | "vertical" = "horizontal",
  ratio = 50,
): WorkspaceLayoutNode => ({ type: "split", direction, ratio, first, second });
const store = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
};
const canonical = (overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout => ({
  ...defaultWorkspaceLayout(),
  panes: { primary: target("/a"), secondary: target("/b") },
  ...overrides,
});

describe("recursive workspace layout", () => {
  it("uses a v6 two-pane default compatible with WorkspaceShell", () => {
    const value = defaultWorkspaceLayout();
    expect(value.version).toBe(6);
    expect(value.splitRatio).toBe(50);
    expect(value.secondaryOpen).toBe(true);
    expect(workspaceLayoutLeafIds(value.root)).toEqual(["primary", "secondary"]);
  });

  it("round-trips nested horizontal and vertical trees with stable IDs", () => {
    const root = split(
      leaf("alpha"),
      split(leaf("beta"), leaf("gamma"), "vertical", 72),
      "horizontal",
      33,
    );
    const raw = JSON.stringify({
      version: 6,
      root,
      focusedPaneId: "gamma",
      panes: { alpha: target("/a"), beta: null, gamma: target("/c") },
      terminal: { open: true, ownerPaneId: "gamma", dockHeightPx: 400 },
      extra: true,
    });
    const parsed = parseWorkspaceLayout(raw);
    expect(parsed.status).toBe("valid");
    expect(parsed.layout.root).toEqual(root);
    expect(parsed.layout.focusedPaneId).toBe("gamma");
    expect(parsed.layout.terminal.open).toBe(true);
  });

  it("clamps every ratio and deterministically recovers stale focus", () => {
    const record = {
      version: 6,
      root: split(leaf("a"), split(leaf("b"), leaf("c"), "vertical", -5), "horizontal", 999),
      focusedPaneId: "gone",
      panes: { a: null, b: null, c: null },
      terminal: { open: false, ownerPaneId: null, dockHeightPx: 80 },
    };
    const parsed = parseWorkspaceLayout(JSON.stringify(record));
    expect(parsed.layout.root).toEqual(
      split(leaf("a"), split(leaf("b"), leaf("c"), "vertical", 10), "horizontal", 90),
    );
    expect(parsed.layout.focusedPaneId).toBe("a");
    expect(parsed.layout.terminal.dockHeightPx).toBe(140);
  });

  it.each([
    [
      "bad direction",
      split(leaf("a"), leaf("b"), "horizontal") as unknown as Record<string, unknown>,
      (node: Record<string, unknown>) => {
        node.direction = "diagonal";
      },
    ],
    ["duplicate leaf", split(leaf("a"), leaf("a")) as unknown as Record<string, unknown>, () => {}],
    [
      "malformed child",
      split(leaf("a"), leaf("b")) as unknown as Record<string, unknown>,
      (node: Record<string, unknown>) => {
        node.second = null;
      },
    ],
  ])("rejects %s", (_name, root, mutate) => {
    mutate(root);
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          version: 6,
          root,
          focusedPaneId: "a",
          panes: { a: null, b: null },
          terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
        }),
      ).status,
    ).toBe("corrupt");
  });

  it("rejects missing descriptors, descriptor overflow, leaf overflow, and depth overflow", () => {
    const terminal = { open: false, ownerPaneId: null, dockHeightPx: 260 };
    expect(
      parseWorkspaceLayout(
        JSON.stringify({ version: 6, root: leaf("a"), focusedPaneId: "a", panes: {}, terminal }),
      ).status,
    ).toBe("corrupt");
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          version: 6,
          root: leaf("a"),
          focusedPaneId: "a",
          panes: { a: null, b: null, c: null, d: null, e: null },
          terminal,
        }),
      ).status,
    ).toBe("corrupt");
    const five = split(split(leaf("a"), leaf("b")), split(leaf("c"), split(leaf("d"), leaf("e"))));
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          version: 6,
          root: five,
          focusedPaneId: "a",
          panes: { a: null, b: null, c: null, d: null, e: null },
          terminal,
        }),
      ).status,
    ).toBe("corrupt");
    const deep = split(leaf("a"), split(leaf("b"), split(leaf("c"), split(leaf("d"), leaf("e")))));
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          version: 6,
          root: deep,
          focusedPaneId: "a",
          panes: { a: null, b: null, c: null, d: null, e: null },
          terminal,
        }),
      ).status,
    ).toBe("corrupt");
  });

  it("closes stale or targetless terminal owners and rejects terminal runtime fields", () => {
    const base = { version: 6, root: leaf("a"), focusedPaneId: "a", panes: { a: null } };
    const parsed = parseWorkspaceLayout(
      JSON.stringify({ ...base, terminal: { open: true, ownerPaneId: "a", dockHeightPx: 300 } }),
    );
    expect(parsed.layout.terminal).toEqual({ open: false, ownerPaneId: null, dockHeightPx: 300 });
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          ...base,
          terminal: { open: false, ownerPaneId: null, dockHeightPx: 300, pid: 1 },
        }),
      ).status,
    ).toBe("corrupt");
  });
});

describe("migration and storage", () => {
  it("migrates v0-v5 while retaining pane targets and closed secondary descriptors", () => {
    const fixedPanes = { primary: target("/a"), secondary: target("/b", "/s") };
    const migratedRecords = [
      { version: 1, splitRatio: 55, panes: fixedPanes },
      { version: 2, splitRatio: 55, secondaryOpen: true, panes: fixedPanes },
      {
        version: 3,
        splitRatio: 55,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: fixedPanes,
      },
      {
        version: 4,
        splitRatio: 55,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: fixedPanes,
        terminal: { open: true, ownerPaneId: "secondary" },
      },
    ];
    for (const record of migratedRecords) {
      const migrated = parseWorkspaceLayout(JSON.stringify(record));
      expect(migrated.status, `v${record.version}`).toBe("migrated");
      expect(migrated.layout.panes, `v${record.version}`).toEqual(fixedPanes);
    }

    const v0 = parseWorkspaceLayout(
      JSON.stringify({
        version: 0,
        ratio: 95,
        primary: { cwd: "/a" },
        secondary: { cwd: "/b", sessionPath: "/s" },
      }),
    );
    expect(v0.status).toBe("migrated");
    expect(v0.layout.splitRatio).toBe(90);
    expect(v0.layout.panes.secondary).toEqual(target("/b", "/s"));
    const v5 = parseWorkspaceLayout(
      JSON.stringify({
        version: 5,
        splitRatio: 63,
        secondaryOpen: false,
        focusedPaneId: "secondary",
        panes: { primary: target("/a"), secondary: target("/b") },
        terminal: { open: true, ownerPaneId: "secondary", dockHeightPx: 420 },
      }),
    );
    expect(v5.layout.root).toEqual(leaf("primary"));
    expect(v5.layout.panes.secondary).toEqual(target("/b"));
    expect(v5.layout.focusedPaneId).toBe("primary");
    expect(v5.layout.terminal).toEqual({ open: false, ownerPaneId: null, dockHeightPx: 420 });

    const damagedHeight = parseWorkspaceLayout(
      JSON.stringify({
        version: 5,
        splitRatio: 50,
        secondaryOpen: false,
        focusedPaneId: "primary",
        panes: { primary: target("/a"), secondary: null },
        terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 50 },
      }),
    );
    expect(damagedHeight.terminalDockHeightRecovery).toEqual({ rejected: 50, resolved: 140 });
  });

  it("loads recursive first and never replaces malformed recursive bytes from v5", () => {
    const { values, storage } = store();
    values.set(workspaceLayoutKey("main"), JSON.stringify({ version: 0 }));
    const raw = " future recursive bytes ";
    values.set(recursiveWorkspaceLayoutKey("main"), raw);
    const loaded = loadWorkspaceLayout(storage, "main");
    expect(loaded.status).toBe("corrupt");
    expect(loaded.rejectedRaw).toBe(raw);
    expect(loaded.rejectedSource).toBe("recursive");
    expect(values.get(rejectedRecursiveWorkspaceLayoutKey("main"))).toBe(raw);
  });

  it("preserves recursive rejected bytes exactly", () => {
    const { values, storage } = store();
    const raw = ' \n{"version":99,"x":"é\\u0000"}\t';
    expect(preserveRejectedRecursiveWorkspaceLayout(storage, "main", raw)).toBe(true);
    expect(values.get(rejectedRecursiveWorkspaceLayoutKey("main"))).toBe(raw);
  });

  it("accepts the fixed WorkspaceShell save shape and dual-writes allow-listed v6/v5", () => {
    const { values, storage } = store();
    const fixed = {
      version: 5,
      splitRatio: 64,
      secondaryOpen: true,
      focusedPaneId: "secondary",
      panes: { primary: target("/a"), secondary: target("/b") },
      terminal: { open: true, ownerPaneId: "secondary", dockHeightPx: 350 },
    };
    expect(saveWorkspaceLayout(storage, "main", fixed)).toBe(true);
    expect(JSON.parse(values.get(recursiveWorkspaceLayoutKey("main"))!).version).toBe(6);
    expect(JSON.parse(values.get(workspaceLayoutKey("main"))!)).toEqual(fixed);
  });

  it("does not overwrite the last v5 snapshot for a nested layout", () => {
    const { values, storage } = store();
    values.set(workspaceLayoutKey("main"), "last-safe-v5");
    const nested = canonical({
      root: split(leaf("primary"), split(leaf("secondary"), leaf("third"), "vertical")),
      panes: { primary: target("/a"), secondary: target("/b"), third: target("/c") },
    });
    expect(saveWorkspaceLayout(storage, "main", nested)).toBe(true);
    expect(values.get(workspaceLayoutKey("main"))).toBe("last-safe-v5");
    expect(values.has(recursiveWorkspaceLayoutKey("main"))).toBe(true);
  });

  it("returns false when either required fixed-layout write fails", () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn((key: string) => {
        if (key.startsWith("gg-workspace-layout:")) throw new Error("quota");
      }),
    };
    expect(saveWorkspaceLayout(storage, "main", canonical())).toBe(false);

    const recursiveFailure = {
      getItem: () => null,
      setItem: vi.fn((key: string) => {
        if (key.startsWith("gg-workspace-layout-recursive:")) throw new Error("blocked");
      }),
    };
    expect(saveWorkspaceLayout(recursiveFailure, "main", canonical())).toBe(false);
  });

  it("returns false instead of throwing for unserializable save input", () => {
    const { storage } = store();
    const value = canonical();
    (value.root as unknown as { cycle: unknown }).cycle = value.root;
    expect(saveWorkspaceLayout(storage, "main", value)).toBe(false);
  });
});

describe("target resolution", () => {
  it("validates every descriptor independently and preserves root IDs", async () => {
    const root = split(leaf("a"), leaf("b"), "vertical", 40);
    const value = canonical({
      root,
      focusedPaneId: "b",
      panes: {
        a: target("/missing", "/s"),
        b: target("/b", "/missing-session"),
        dormant: target("/throws"),
      },
      terminal: { open: true, ownerPaneId: "a", dockHeightPx: 300 },
    });
    const validate = vi.fn(async ({ cwd }: { cwd: string }) => {
      if (cwd === "/throws") throw new Error("failed");
      return { projectExists: cwd !== "/missing", sessionExists: false };
    });
    const resolved = await resolveWorkspaceLayoutTargets(value, validate);
    expect(resolved.root).toEqual(root);
    expect(resolved.panes).toEqual({ a: null, b: target("/b"), dormant: null });
    expect(resolved.focusedPaneId).toBe("b");
    expect(resolved.terminal).toEqual({ open: false, ownerPaneId: null, dockHeightPx: 300 });
    expect(validate).toHaveBeenCalledTimes(3);
  });
});
