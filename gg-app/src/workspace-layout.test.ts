import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKSPACE_LAYOUT_DEPTH,
  MAX_WORKSPACE_LAYOUT_LEAVES,
  addTerminalWorkspacePane,
  bootstrapDefaultTerminalWorkspacePane,
  defaultWorkspaceLayout,
  isTerminalPaneMoveRequest,
  isTerminalPanePlacement,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  preserveRejectedRecursiveWorkspaceLayout,
  recursiveWorkspaceLayoutKey,
  rejectedRecursiveWorkspaceLayoutKey,
  removeWorkspacePane,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  splitWorkspacePane,
  terminalOnlyWorkspaceLayout,
  updateWorkspaceSplitRatio,
  validateWorkspaceLayoutCandidate,
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
const record = (
  version: 7 | 8,
  root: WorkspaceLayoutNode,
  panes: Record<string, unknown>,
  focusedPaneId = "primary",
  defaultTerminalBootstrap: "pending" | "complete" = "complete",
) => ({
  version,
  root: storedNode(root),
  focusedPaneId,
  panes,
  ...(version === 8 ? { defaultTerminalBootstrap } : {}),
});
const v8 = (
  root: WorkspaceLayoutNode,
  panes: Record<string, unknown>,
  focusedPaneId = "primary",
  bootstrap: "pending" | "complete" = "complete",
) => JSON.stringify(record(8, root, panes, focusedPaneId, bootstrap));
const v7 = (root: WorkspaceLayoutNode, panes: Record<string, unknown>, focusedPaneId = "primary") =>
  JSON.stringify(record(7, root, panes, focusedPaneId));
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
const comb = (count: number): WorkspaceLayoutNode => {
  let root = leaf("primary");
  for (let index = 1; index < count; index += 1) root = split(root, leaf(`pane-${index}`));
  return root;
};
const descriptors = (count: number) =>
  Object.fromEntries(
    ["primary", ...Array.from({ length: count - 1 }, (_, index) => `pane-${index + 1}`)].map(
      (id) => [id, agent(`/${id}`)],
    ),
  );

const leafGuardLayout = (leafCount: 63 | 64, agentCount = 4): WorkspaceLayout => {
  const agentIds = [
    "primary",
    ...Array.from({ length: agentCount - 1 }, (_, index) => `pane-${index + 1}`),
  ];
  const terminalIds = Array.from(
    { length: leafCount - agentIds.length },
    (_, index) => `terminal-${index + 1}`,
  );
  const ids = [...agentIds, ...terminalIds];
  const root = ids
    .slice(1)
    .reduce<WorkspaceLayoutNode>((node, paneId) => split(node, leaf(paneId)), leaf(ids[0]));
  return canonical({
    root,
    focusedPaneId: "primary",
    panes: Object.fromEntries(
      ids.map((id) => [id, id.startsWith("terminal-") ? terminal(`/${id}`) : agent(`/${id}`)]),
    ),
  });
};
describe("v8 typed workspace schema", () => {
  it("uses one v8 recursive tree and records completed bootstrap by default", () => {
    const layout = defaultWorkspaceLayout();
    expect(layout.version).toBe(8);
    expect(layout.defaultTerminalBootstrap).toBe("complete");
    expect(workspaceLayoutLeafIds(layout.root)).toEqual(["primary", "secondary"]);
  });

  it("round-trips typed agent and stopped terminal leaves with bootstrap metadata", () => {
    const root = split(dock(leaf("primary"), leaf("terminal-1"), 410), leaf("secondary"));
    const parsed = parseWorkspaceLayout(
      v8(
        root,
        {
          primary: agent("/a", "/s"),
          "terminal-1": terminal("/a", "/s"),
          secondary: agent("/b"),
        },
        "terminal-1",
        "pending",
      ),
    );
    expect(parsed.status).toBe("valid");
    expect(parsed.layout.root).toEqual(root);
    expect(parsed.layout.focusedPaneId).toBe("terminal-1");
    expect(parsed.layout.defaultTerminalBootstrap).toBe("pending");
    expect(parsed.layout.panes["terminal-1"]).toEqual(terminal("/a", "/s"));
    expect(parsed.layout.terminal).toEqual({
      open: true,
      ownerPaneId: "primary",
      dockHeightPx: 410,
    });
  });

  it.each([undefined, null, "waiting", true])("rejects invalid bootstrap metadata %s", (value) => {
    const candidate = record(8, leaf("primary"), { primary: agent("/a") }) as Record<
      string,
      unknown
    >;
    candidate.defaultTerminalBootstrap = value;
    expect(validateWorkspaceLayoutCandidate(candidate)).toBeNull();
    expect(parseWorkspaceLayout(JSON.stringify(candidate)).status).toBe("corrupt");
  });

  it.each([
    ["missing kind", target("/a")],
    ["unknown kind", { kind: "editor", ...target("/a") }],
    ["runtime id", { ...terminal("/a"), terminalId: "native-1" }],
    ["pid", { ...terminal("/a"), pid: 1 }],
    ["output", { ...terminal("/a"), output: "secret" }],
    ["running state", { ...terminal("/a"), stopped: false }],
  ])("rejects %s in canonical descriptors", (_name, descriptor) => {
    expect(parseWorkspaceLayout(v8(leaf("primary"), { primary: descriptor })).status).toBe(
      "corrupt",
    );
  });

  it("validates exactly 64 leaves and rejects 65 leaves or excess depth", () => {
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, comb(MAX_WORKSPACE_LAYOUT_LEAVES), descriptors(64)),
      ),
    ).not.toBeNull();
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, comb(MAX_WORKSPACE_LAYOUT_LEAVES + 1), descriptors(65)),
      ),
    ).toBeNull();
    let root: WorkspaceLayoutNode = leaf("primary");
    const deepPanes: Record<string, unknown> = { primary: agent("/primary") };
    for (let depth = 1; depth <= MAX_WORKSPACE_LAYOUT_DEPTH; depth += 1) {
      root = split(root, leaf(`deep-${depth}`));
      deepPanes[`deep-${depth}`] = agent(`/deep-${depth}`);
    }
    expect(validateWorkspaceLayoutCandidate(record(8, root, deepPanes))).toBeNull();
  });

  it("accepts the UI's exact kind-optional agent descriptor at the candidate boundary", () => {
    const candidate = record(8, leaf("primary"), { primary: target("/a") });
    expect(validateWorkspaceLayoutCandidate(candidate)?.panes.primary).toEqual(agent("/a"));
    expect(parseWorkspaceLayout(JSON.stringify(candidate)).status).toBe("corrupt");
  });

  it("rejects duplicate and invalid IDs plus stale and missing descriptors", () => {
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, split(leaf("primary"), leaf("primary")), { primary: agent("/a") }),
      ),
    ).toBeNull();
    expect(
      validateWorkspaceLayoutCandidate(record(8, leaf("bad pane"), { "bad pane": agent("/a") })),
    ).toBeNull();
    expect(validateWorkspaceLayoutCandidate(record(8, leaf("primary"), {}))).toBeNull();
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, leaf("primary"), { primary: agent("/a"), stale: agent("/b") }),
      ),
    ).toBeNull();
  });

  it("rejects invalid fixed topology", () => {
    const horizontalFixed = {
      ...dock(leaf("primary"), leaf("terminal-1")),
      direction: "horizontal",
    };
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, horizontalFixed as WorkspaceLayoutNode, {
          primary: agent("/a"),
          "terminal-1": terminal("/a"),
        }),
      ),
    ).toBeNull();
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, dock(leaf("primary"), leaf("secondary")), {
          primary: agent("/a"),
          secondary: agent("/b"),
        }),
      ),
    ).toBeNull();
  });

  it("rejects non-finite sizes, clamps finite sizes, and restores stale focus", () => {
    const finite = record(
      8,
      dock(leaf("primary"), leaf("terminal-1"), 50),
      {
        primary: agent("/a"),
        "terminal-1": terminal("/a"),
      },
      "gone",
    );
    const parsed = validateWorkspaceLayoutCandidate(finite)!;
    expect(parsed.focusedPaneId).toBe("primary");
    expect((parsed.root as Extract<WorkspaceLayoutNode, { type: "split" }>).size).toEqual({
      type: "fixed-second",
      pixels: 140,
    });
    expect(
      validateWorkspaceLayoutCandidate(
        record(8, split(leaf("primary"), leaf("secondary"), "horizontal", Number.NaN), {
          primary: agent("/a"),
          secondary: agent("/b"),
        }),
      ),
    ).toBeNull();
    const clamped = validateWorkspaceLayoutCandidate(
      record(8, split(leaf("primary"), leaf("secondary"), "horizontal", 999), {
        primary: agent("/a"),
        secondary: agent("/b"),
      }),
    )!;
    expect(clamped.splitRatio).toBe(90);
  });
});

describe("v0-v7 structural compatibility", () => {
  it("migrates explicit v7 input without changing tree, descriptors, focus, or terminal geometry", () => {
    const root = split(
      leaf("primary"),
      dock(leaf("secondary"), leaf("terminal-1"), 420),
      "horizontal",
      65,
    );
    const panes = {
      primary: agent("/a"),
      secondary: agent("/b", "/session"),
      "terminal-1": terminal("/b", "/session"),
    };
    const parsed = parseWorkspaceLayout(v7(root, panes, "terminal-1"));
    expect(parsed.status).toBe("migrated");
    expect(parsed.layout).toMatchObject({
      version: 8,
      root,
      panes,
      focusedPaneId: "terminal-1",
      defaultTerminalBootstrap: "complete",
      terminal: { open: true, ownerPaneId: "secondary", dockHeightPx: 420 },
    });
    expect(workspaceLayoutLeafIds(parsed.layout.root)).toHaveLength(3);
  });

  it("migrates v6 agents, closed docks, open docks, and recovery", () => {
    const closed = parseWorkspaceLayout(v6());
    expect(closed.status).toBe("migrated");
    expect(closed.layout.defaultTerminalBootstrap).toBe("complete");
    expect(closed.layout.panes).toEqual({
      primary: agent("/a"),
      secondary: agent("/b", "/session"),
    });
    const open = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "secondary", dockHeightPx: 420 } }),
    );
    expect(workspaceLayoutLeafIds(open.layout.root)).toEqual([
      "primary",
      "secondary",
      "terminal-1",
    ]);
    expect(open.layout.panes["terminal-1"]).toEqual(terminal("/b", "/session"));
    const missing = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "gone", dockHeightPx: 260 } }),
    );
    expect(missing.terminalRecovery).toEqual({ ownerPaneId: "gone", reason: "missing" });
    const unbound = parseWorkspaceLayout(
      v6({
        panes: { primary: null, secondary: target("/b") },
        terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 260 },
      }),
    );
    expect(unbound.terminalRecovery).toEqual({ ownerPaneId: "primary", reason: "unbound" });
    const clamped = parseWorkspaceLayout(
      v6({ terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 50 } }),
    );
    expect(clamped.terminalDockHeightRecovery).toEqual({ rejected: 50, resolved: 140 });
  });

  it("reads v0-v5 with the exact same visible projection", () => {
    const records = [
      { version: 0, ratio: 65, primary: { cwd: "/a" }, secondary: null },
      { version: 1, splitRatio: 65, panes: { primary: target("/a"), secondary: null } },
      {
        version: 2,
        splitRatio: 65,
        secondaryOpen: true,
        panes: { primary: target("/a"), secondary: null },
      },
      {
        version: 3,
        splitRatio: 65,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: { primary: target("/a"), secondary: null },
      },
      {
        version: 4,
        splitRatio: 65,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: { primary: target("/a"), secondary: null },
        terminal: { open: false, ownerPaneId: null },
      },
      {
        version: 5,
        splitRatio: 65,
        secondaryOpen: true,
        focusedPaneId: "secondary",
        panes: { primary: target("/a"), secondary: null },
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      },
    ];
    for (const legacy of records) {
      const parsed = parseWorkspaceLayout(JSON.stringify(legacy));
      const expectedFocus = legacy.version <= 2 ? "primary" : "secondary";
      expect(parsed.status, `v${legacy.version}`).toBe("migrated");
      expect(parsed.layout).toMatchObject({
        version: 8,
        root: split(leaf("primary"), leaf("secondary"), "horizontal", 65),
        panes: { primary: agent("/a"), secondary: null },
        focusedPaneId: expectedFocus,
        defaultTerminalBootstrap: "complete",
        terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
      });
      expect(workspaceLayoutLeafIds(parsed.layout.root)).toHaveLength(2);
    }
  });

  it("rejects stale extra v6 descriptor records", () => {
    expect(
      parseWorkspaceLayout(
        v6({ panes: { primary: target("/a"), secondary: target("/b"), stale: target("/c") } }),
      ).status,
    ).toBe("corrupt");
  });
});

describe("bootstrap load semantics", () => {
  it("returns pending only when storage is missing and one primary is fresh", () => {
    const { storage } = store();
    expect(loadWorkspaceLayout(storage, "main")).toMatchObject({
      status: "missing",
      layout: {
        root: leaf("primary"),
        panes: { primary: null },
        defaultTerminalBootstrap: "pending",
      },
    });
  });

  it("returns complete defaults for corrupt and load-error", () => {
    const corrupt = store();
    corrupt.values.set(recursiveWorkspaceLayoutKey("main"), "bad");
    expect(loadWorkspaceLayout(corrupt.storage, "main")).toMatchObject({
      status: "corrupt",
      layout: { defaultTerminalBootstrap: "complete" },
    });
    expect(
      loadWorkspaceLayout(
        {
          getItem: () => {
            throw new Error("read");
          },
          setItem: vi.fn(),
        },
        "main",
      ),
    ).toMatchObject({
      status: "load-error",
      layout: { defaultTerminalBootstrap: "complete" },
    });
  });
});

describe("movement guards", () => {
  it.each(["left", "right", "up", "down"])("accepts %s placement", (placement) => {
    expect(isTerminalPanePlacement(placement)).toBe(true);
  });
  it.each(["center", "", null, 1])("rejects placement %s", (placement) => {
    expect(isTerminalPanePlacement(placement)).toBe(false);
  });
  it("accepts only the exact movement request shape", () => {
    const valid = { terminalPaneId: "terminal-1", targetPaneId: "primary", placement: "left" };
    expect(isTerminalPaneMoveRequest(valid)).toBe(true);
    expect(isTerminalPaneMoveRequest({ ...valid, placement: "center" })).toBe(false);
    expect(isTerminalPaneMoveRequest({ ...valid, terminalPaneId: "bad pane" })).toBe(false);
    expect(isTerminalPaneMoveRequest({ ...valid, targetPaneId: "" })).toBe(false);
    expect(isTerminalPaneMoveRequest({ ...valid, extra: true })).toBe(false);
    expect(
      isTerminalPaneMoveRequest({ ...valid, kind: "agent", cwd: "/a", sessionPath: null }),
    ).toBe(false);
  });
});

describe("v8 reducers", () => {
  it("creates terminals and preserves pending bootstrap", () => {
    const layout = canonical({
      defaultTerminalBootstrap: "pending",
      panes: { primary: agent("/project"), secondary: agent("/other") },
    });
    const first = addTerminalWorkspacePane(layout, "primary");
    expect(workspaceLayoutLeafIds(first.root)).toEqual(["primary", "terminal-1", "secondary"]);
    expect(first.panes["terminal-1"]).toEqual(terminal("/project"));
    expect(first.defaultTerminalBootstrap).toBe("pending");
    const unbound = canonical({ panes: { primary: null, secondary: agent("/b") } });
    expect(addTerminalWorkspacePane(unbound, "primary")).toBe(unbound);
    expect(addTerminalWorkspacePane(first, "terminal-1")).toBe(first);
  });

  it("allows terminal creation at 63 leaves and blocks the 65th total leaf", () => {
    const layout = leafGuardLayout(63);

    const next = addTerminalWorkspacePane(layout, "primary");

    expect(workspaceLayoutLeafIds(next.root)).toHaveLength(64);
    expect(next.panes["terminal-60"]).toEqual(terminal("/primary"));
    expect(addTerminalWorkspacePane(next, "primary")).toBe(next);
  });

  it("splits, resizes, and removes while preserving pending bootstrap", () => {
    const layout = canonical({ defaultTerminalBootstrap: "pending" });
    const splitLayout = splitWorkspacePane(layout, "primary", "vertical", "pane-3");
    expect(splitLayout.panes["pane-3"]).toBeNull();
    expect(splitLayout.defaultTerminalBootstrap).toBe("pending");
    const resized = updateWorkspaceSplitRatio(splitLayout, [], 80);
    expect(resized.defaultTerminalBootstrap).toBe("pending");
    expect(removeWorkspacePane(resized, "pane-3").defaultTerminalBootstrap).toBe("pending");
    expect(removeWorkspacePane(layout, "primary")).toBe(layout);
  });

  it("splits stopped terminals uniquely and fails closed for malformed terminal targets", () => {
    const parsed = parseWorkspaceLayout(
      v8(
        dock(leaf("primary"), leaf("terminal-1")),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/project", "/session"),
        },
        "terminal-1",
        "pending",
      ),
    ).layout;
    const layout = { ...parsed, panes: { ...parsed.panes, "terminal-2": terminal("/stale") } };
    const next = splitWorkspacePane(layout, "terminal-1", "horizontal", "pane-99");
    expect(workspaceLayoutLeafIds(next.root)).toEqual(["primary", "terminal-1", "terminal-3"]);
    expect(next.panes["terminal-3"]).toEqual(terminal("/project", "/session"));
    expect(next.defaultTerminalBootstrap).toBe("pending");
    const malformed = {
      ...parsed,
      panes: { ...parsed.panes, "terminal-1": { kind: "terminal", stopped: true, cwd: "" } },
    } as unknown as WorkspaceLayout;
    expect(splitWorkspacePane(malformed, "terminal-1", "horizontal")).toBe(malformed);
  });

  it("copies stopped terminal splits at 63 leaves and blocks the 65th total leaf", () => {
    const layout = leafGuardLayout(63);
    const next = splitWorkspacePane(layout, "terminal-1", "horizontal", "pane-99");

    expect(workspaceLayoutLeafIds(next.root)).toHaveLength(64);
    expect(next.panes["terminal-60"]).toEqual(terminal("/terminal-1"));
    expect(next.panes).not.toHaveProperty("pane-99");
    expect(splitWorkspacePane(next, "terminal-1", "horizontal")).toBe(next);
  });

  it("blocks agent splits at 64 total leaves even below the agent-pane cap", () => {
    const capped = leafGuardLayout(64, 3);

    expect(splitWorkspacePane(capped, "primary", "horizontal")).toBe(capped);
  });

  it("does not resize fixed terminal splits and focuses owner when terminal is removed", () => {
    const layout = parseWorkspaceLayout(
      v8(
        dock(leaf("primary"), leaf("terminal-1")),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/a"),
        },
        "terminal-1",
        "pending",
      ),
    ).layout;
    expect(updateWorkspaceSplitRatio(layout, [], 80)).toBe(layout);
    const removed = removeWorkspacePane(layout, "terminal-1");
    expect(removed).toMatchObject({
      root: leaf("primary"),
      focusedPaneId: "primary",
      defaultTerminalBootstrap: "pending",
    });
  });
  it("bootstraps a fresh bound primary exactly once", () => {
    const { storage } = store();
    const fresh = loadWorkspaceLayout(storage, "main").layout;
    const hydrated = {
      ...fresh,
      panes: { primary: agent("/project", "/session") },
    };

    const bootstrapped = bootstrapDefaultTerminalWorkspacePane(hydrated);

    expect(workspaceLayoutLeafIds(bootstrapped.root)).toEqual(["primary", "terminal-1"]);
    expect(bootstrapped.root).toEqual(dock(leaf("primary"), leaf("terminal-1")));
    expect(bootstrapped.panes["terminal-1"]).toEqual(terminal("/project", "/session"));
    expect(bootstrapped.defaultTerminalBootstrap).toBe("complete");
    expect(bootstrapDefaultTerminalWorkspacePane(bootstrapped)).toBe(bootstrapped);
  });

  it("leaves pending when insertion is unsafe", () => {
    const { storage } = store();
    const pending = loadWorkspaceLayout(storage, "main").layout;
    expect(bootstrapDefaultTerminalWorkspacePane(pending)).toBe(pending);
    expect(pending.defaultTerminalBootstrap).toBe("pending");

    const extraVisible = {
      ...pending,
      root: split(leaf("primary"), leaf("pane-1")),
      panes: { primary: agent("/project"), "pane-1": agent("/other") },
    };
    expect(bootstrapDefaultTerminalWorkspacePane(extraVisible)).toBe(extraVisible);
    expect(extraVisible.defaultTerminalBootstrap).toBe("pending");

    const existingTerminal = {
      ...pending,
      root: dock(leaf("primary"), leaf("terminal-1")),
      panes: { primary: agent("/project"), "terminal-1": terminal("/project") },
    };
    expect(bootstrapDefaultTerminalWorkspacePane(existingTerminal)).toBe(existingTerminal);
    expect(existingTerminal.defaultTerminalBootstrap).toBe("pending");
  });

  it("does not change complete, migrated, or terminal-only layouts", () => {
    const complete = defaultWorkspaceLayout();
    expect(bootstrapDefaultTerminalWorkspacePane(complete)).toBe(complete);

    const migratedV6 = parseWorkspaceLayout(v6()).layout;
    expect(bootstrapDefaultTerminalWorkspacePane(migratedV6)).toBe(migratedV6);

    const migratedV7 = parseWorkspaceLayout(
      v7(split(leaf("primary"), leaf("secondary")), {
        primary: agent("/a"),
        secondary: agent("/b"),
      }),
    ).layout;
    expect(bootstrapDefaultTerminalWorkspacePane(migratedV7)).toBe(migratedV7);

    const terminalOnly = terminalOnlyWorkspaceLayout(target("/project"))!;
    expect(bootstrapDefaultTerminalWorkspacePane(terminalOnly)).toBe(terminalOnly);
  });

  it("persists completion with terminal insertion in one canonical record", () => {
    const { values, storage } = store();
    const fresh = loadWorkspaceLayout(storage, "main").layout;
    const bootstrapped = bootstrapDefaultTerminalWorkspacePane({
      ...fresh,
      panes: { primary: agent("/project", "/session") },
    });

    expect(saveWorkspaceLayout(storage, "main", bootstrapped)).toBe(true);
    const saved = JSON.parse(values.get(recursiveWorkspaceLayoutKey("main"))!);
    expect(saved.defaultTerminalBootstrap).toBe("complete");
    expect(
      Object.values(saved.panes).filter(
        (descriptor) =>
          typeof descriptor === "object" &&
          descriptor !== null &&
          (descriptor as { kind?: string }).kind === "terminal",
      ),
    ).toEqual([terminal("/project", "/session")]);

    const loaded = loadWorkspaceLayout(storage, "main");
    expect(loaded.status).toBe("valid");
    expect(workspaceLayoutLeafIds(loaded.layout.root)).toEqual(["primary", "terminal-1"]);
    expect(loaded.layout.defaultTerminalBootstrap).toBe("complete");
  });
});

describe("target resolution", () => {
  it("preserves pending bootstrap while clearing invalid agents and stale sessions", async () => {
    const layout = canonical({
      defaultTerminalBootstrap: "pending",
      panes: { primary: agent("/missing"), secondary: agent("/ok", "/stale") },
    });
    const resolved = await resolveWorkspaceLayoutTargets(layout, async ({ cwd }) => ({
      projectExists: cwd === "/ok",
      sessionExists: false,
    }));
    expect(resolved.panes).toEqual({ primary: null, secondary: agent("/ok") });
    expect(resolved.defaultTerminalBootstrap).toBe("pending");
  });

  it("prunes invalid terminals and preserves pending bootstrap", async () => {
    const layout = parseWorkspaceLayout(
      v8(
        dock(leaf("primary"), leaf("terminal-1")),
        {
          primary: agent("/a"),
          "terminal-1": terminal("/bad"),
        },
        "terminal-1",
        "pending",
      ),
    ).layout;
    const resolved = await resolveWorkspaceLayoutTargets(layout, async ({ cwd }) => ({
      projectExists: cwd !== "/bad",
      sessionExists: true,
    }));
    expect(resolved.root).toEqual(leaf("primary"));
    expect(resolved.panes).not.toHaveProperty("terminal-1");
    expect(resolved.defaultTerminalBootstrap).toBe("pending");
  });
});

describe("terminal-only native workspace", () => {
  it.each([null, "/sessions/terminal.jsonl"])(
    "constructs and round-trips terminal with session %s",
    (sessionPath) => {
      const layout = terminalOnlyWorkspaceLayout({ cwd: "C:\\project", sessionPath });
      expect(layout).toMatchObject({
        version: 8,
        root: leaf("terminal-1"),
        focusedPaneId: "terminal-1",
        panes: { "terminal-1": terminal("C:\\project", sessionPath) },
        defaultTerminalBootstrap: "complete",
      });
      const { storage } = store();
      expect(saveWorkspaceLayout(storage, "project-2", layout!)).toBe(true);
      expect(loadWorkspaceLayout(storage, "project-2")).toMatchObject({
        status: "valid",
        layout: { root: leaf("terminal-1") },
      });
    },
  );

  it.each([
    [
      "extra pane",
      v8(leaf("terminal-1"), { "terminal-1": terminal("/a"), extra: agent("/b") }, "terminal-1"),
    ],
    [
      "split root",
      v8(
        split(leaf("terminal-1"), leaf("terminal-2")),
        { "terminal-1": terminal("/a"), "terminal-2": terminal("/a") },
        "terminal-1",
      ),
    ],
    ["blank cwd", v8(leaf("terminal-1"), { "terminal-1": terminal("") }, "terminal-1")],
    ["agent descriptor", v8(leaf("terminal-1"), { "terminal-1": agent("/a") }, "terminal-1")],
    ["wrong focus", v8(leaf("terminal-1"), { "terminal-1": terminal("/a") }, "primary")],
  ])("rejects %s", (_name, raw) => expect(parseWorkspaceLayout(raw).status).toBe("corrupt"));
});

describe("v8 storage and rollback", () => {
  it("writes canonical v8 metadata without compatibility or runtime fields", () => {
    const { values, storage } = store();
    const layout = canonical({ defaultTerminalBootstrap: "pending" });
    expect(saveWorkspaceLayout(storage, "main", layout)).toBe(true);
    const saved = JSON.parse(values.get(recursiveWorkspaceLayoutKey("main"))!);
    expect(saved).toMatchObject({
      version: 8,
      defaultTerminalBootstrap: "pending",
      panes: { primary: agent("/a") },
    });
    expect(saved).not.toHaveProperty("terminal");
    expect(saved).not.toHaveProperty("splitRatio");
    expect(JSON.stringify(saved)).not.toContain("terminalId");
    expect(loadWorkspaceLayout(storage, "main")).toMatchObject({
      status: "valid",
      layout: { defaultTerminalBootstrap: "pending" },
    });
  });

  it("projects one terminal to v5 and leaves rollback untouched for multiple terminals", () => {
    const single = store();
    const layout = parseWorkspaceLayout(
      v8(dock(leaf("primary"), leaf("terminal-1"), 350), {
        primary: agent("/a"),
        "terminal-1": terminal("/a"),
      }),
    ).layout;
    expect(saveWorkspaceLayout(single.storage, "main", layout)).toBe(true);
    expect(JSON.parse(single.values.get(workspaceLayoutKey("main"))!)).toMatchObject({
      version: 5,
      terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 350 },
    });

    const multiple = store();
    multiple.values.set(workspaceLayoutKey("main"), "last-safe-v5");
    const multi = parseWorkspaceLayout(
      v8(
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
    expect(saveWorkspaceLayout(multiple.storage, "main", multi)).toBe(true);
    expect(multiple.values.get(workspaceLayoutKey("main"))).toBe("last-safe-v5");
  });

  it("reads recursive first and preserves malformed bytes without legacy fallback", () => {
    const { values, storage } = store();
    const raw = ' \n{"version":99,"x":"é\\u0000"}\t';
    values.set(recursiveWorkspaceLayoutKey("main"), raw);
    values.set(workspaceLayoutKey("main"), v6());
    const loaded = loadWorkspaceLayout(storage, "main");
    expect(loaded).toMatchObject({
      status: "corrupt",
      rejectedRaw: raw,
      rejectedSource: "recursive",
      layout: { defaultTerminalBootstrap: "complete" },
    });
    expect(values.get(rejectedRecursiveWorkspaceLayoutKey("main"))).toBe(raw);
    expect(preserveRejectedRecursiveWorkspaceLayout(storage, "other", raw)).toBe(true);
  });

  it("falls back to legacy only when recursive storage is absent", () => {
    const { values, storage } = store();
    values.set(workspaceLayoutKey("main"), v6());
    expect(loadWorkspaceLayout(storage, "main").status).toBe("migrated");
  });

  it("returns false for invalid bootstrap, invalid descriptors, circular input, and failed saves", () => {
    const { values, storage } = store();
    expect(
      saveWorkspaceLayout(
        storage,
        "main",
        canonical({ defaultTerminalBootstrap: undefined as never }),
      ),
    ).toBe(false);
    expect(values.has(recursiveWorkspaceLayoutKey("main"))).toBe(false);
    expect(
      saveWorkspaceLayout(
        storage,
        "main",
        canonical({ defaultTerminalBootstrap: "unknown" as never }),
      ),
    ).toBe(false);
    expect(values.has(recursiveWorkspaceLayoutKey("main"))).toBe(false);
    expect(
      saveWorkspaceLayout(storage, "main", canonical({ panes: { primary: agent("/a") } })),
    ).toBe(false);
    expect(values.has(recursiveWorkspaceLayoutKey("main"))).toBe(false);
    const invalidDescriptors: Array<[string, WorkspaceLayout]> = [
      [
        "unknown kind",
        canonical({
          panes: { primary: { kind: "editor", ...target("/a") } as never, secondary: agent("/b") },
        }),
      ],
      [
        "running terminal",
        canonical({
          root: dock(leaf("primary"), leaf("terminal-1")),
          panes: {
            primary: agent("/a"),
            "terminal-1": { ...terminal("/a"), stopped: false } as never,
          },
        }),
      ],
      [
        "terminalId",
        canonical({
          root: dock(leaf("primary"), leaf("terminal-1")),
          panes: {
            primary: agent("/a"),
            "terminal-1": { ...terminal("/a"), terminalId: "native-1" } as never,
          },
        }),
      ],
      [
        "pid",
        canonical({
          root: dock(leaf("primary"), leaf("terminal-1")),
          panes: { primary: agent("/a"), "terminal-1": { ...terminal("/a"), pid: 1 } as never },
        }),
      ],
      [
        "output",
        canonical({
          root: dock(leaf("primary"), leaf("terminal-1")),
          panes: {
            primary: agent("/a"),
            "terminal-1": { ...terminal("/a"), output: "secret" } as never,
          },
        }),
      ],
    ];
    for (const [name, layout] of invalidDescriptors) {
      expect(saveWorkspaceLayout(storage, `invalid-${name}`, layout)).toBe(false);
      expect(values.has(recursiveWorkspaceLayoutKey(`invalid-${name}`))).toBe(false);
    }
    const circular = canonical();
    (circular.root as unknown as { first: unknown }).first = circular.root;
    expect(saveWorkspaceLayout(storage, "main", circular)).toBe(false);
    expect(values.has(recursiveWorkspaceLayoutKey("main"))).toBe(false);
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
