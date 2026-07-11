import { describe, expect, it, vi } from "vitest";
import {
  defaultWorkspaceLayout,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  preserveRejectedWorkspaceLayout,
  rejectedWorkspaceLayoutKey,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  workspaceLayoutKey,
  type WorkspaceLayout,
} from "./workspace-layout";

const target = (cwd: string, sessionPath: string | null = null) => ({ cwd, sessionPath });

function layout(overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout {
  return {
    ...defaultWorkspaceLayout(),
    panes: { primary: target("/project/a", "/sessions/a.jsonl"), secondary: null },
    ...overrides,
  };
}

describe("workspace layout storage", () => {
  it("migrates the focused v0 shape and clamps its split ratio", () => {
    const result = parseWorkspaceLayout(
      JSON.stringify({
        version: 0,
        ratio: 150,
        primary: { cwd: "/project/a" },
        secondary: { cwd: "/project/b", sessionPath: "/sessions/b.jsonl" },
      }),
    );

    expect(result.status).toBe("migrated");
    expect(result.layout).toEqual({
      version: 4,
      splitRatio: 90,
      secondaryOpen: true,
      focusedPaneId: "primary",
      panes: {
        primary: target("/project/a"),
        secondary: target("/project/b", "/sessions/b.jsonl"),
      },
      terminal: { open: false, ownerPaneId: null },
    });
  });

  it("normalizes missing session paths for both legacy pane targets", () => {
    const result = parseWorkspaceLayout(
      JSON.stringify({
        version: 0,
        primary: { cwd: "/project/a" },
        secondary: { cwd: "/project/b" },
      }),
    );

    expect(result.status).toBe("migrated");
    expect(result.layout.panes).toEqual({
      primary: target("/project/a"),
      secondary: target("/project/b"),
    });
  });

  it.each(["primary", "secondary"] as const)(
    "rejects an invalid legacy session path type in the %s pane",
    (paneId) => {
      expect(
        parseWorkspaceLayout(
          JSON.stringify({ version: 0, [paneId]: { cwd: "/project/a", sessionPath: 42 } }),
        ).status,
      ).toBe("corrupt");
    },
  );

  it.each([
    "not-json",
    "null",
    JSON.stringify({ version: 99 }),
    JSON.stringify({ version: 1, splitRatio: 50, panes: { primary: { cwd: "" } } }),
  ])("falls back for corrupt or unsupported data: %s", (raw) => {
    expect(parseWorkspaceLayout(raw)).toEqual({
      layout: defaultWorkspaceLayout(),
      status: "corrupt",
    });
  });

  it("migrates v1 records with damaged ratios without losing pane selections", () => {
    const result = parseWorkspaceLayout(
      JSON.stringify({
        version: 1,
        splitRatio: -20,
        panes: { primary: target("/project/a"), secondary: target("/project/b") },
      }),
    );

    expect(result.status).toBe("migrated");
    expect(result.layout.splitRatio).toBe(10);
    expect(result.layout.focusedPaneId).toBe("primary");
    expect(result.layout.panes.secondary?.cwd).toBe("/project/b");
  });

  it("migrates v2 records with primary focus while preserving pane state", () => {
    const result = parseWorkspaceLayout(
      JSON.stringify({
        version: 2,
        splitRatio: 63,
        secondaryOpen: false,
        panes: {
          primary: target("/project/a", "/sessions/a.jsonl"),
          secondary: target("/project/b", "/sessions/b.jsonl"),
        },
      }),
    );

    expect(result).toEqual({
      status: "migrated",
      layout: {
        version: 4,
        splitRatio: 63,
        secondaryOpen: false,
        focusedPaneId: "primary",
        panes: {
          primary: target("/project/a", "/sessions/a.jsonl"),
          secondary: target("/project/b", "/sessions/b.jsonl"),
        },
        terminal: { open: false, ownerPaneId: null },
      },
    });
  });

  it("migrates v3 with a closed terminal", () => {
    const record = { ...layout(), version: 3 };
    delete (record as Partial<WorkspaceLayout>).terminal;

    expect(parseWorkspaceLayout(JSON.stringify(record))).toEqual({
      status: "migrated",
      layout: layout(),
    });
  });

  it("restores valid secondary focus from v4", () => {
    const parsed = parseWorkspaceLayout(JSON.stringify(layout({ focusedPaneId: "secondary" })));

    expect(parsed.status).toBe("valid");
    expect(parsed.layout.focusedPaneId).toBe("secondary");
  });

  it.each([
    ["absent", undefined],
    ["non-string", 42],
    ["unknown", "tertiary"],
  ])(
    "normalizes %s v4 focus to primary without rejecting pane targets",
    (_label, focusedPaneId) => {
      const record: Record<string, unknown> = { ...layout(), focusedPaneId };
      if (focusedPaneId === undefined) delete record.focusedPaneId;

      const parsed = parseWorkspaceLayout(JSON.stringify(record));

      expect(parsed.status).toBe("valid");
      expect(parsed.layout.focusedPaneId).toBe("primary");
      expect(parsed.layout.panes.primary).toEqual(target("/project/a", "/sessions/a.jsonl"));
    },
  );

  it("normalizes secondary focus to primary when the secondary pane is closed", () => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify(
        layout({
          secondaryOpen: false,
          focusedPaneId: "secondary",
          panes: { primary: target("/a"), secondary: target("/b") },
        }),
      ),
    );

    expect(parsed.status).toBe("valid");
    expect(parsed.layout.focusedPaneId).toBe("primary");
    expect(parsed.layout.panes.secondary).toEqual(target("/b"));
  });

  it.each([
    [true, "primary"],
    [true, "secondary"],
    [false, null],
  ] as const)("accepts strict v4 terminal state %s/%s", (terminalOpen, terminalOwnerPaneId) => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify(
        layout({ terminal: { open: terminalOpen, ownerPaneId: terminalOwnerPaneId } }),
      ),
    );
    expect(parsed.status).toBe("valid");
    expect(parsed.layout.terminal).toEqual({
      open: terminalOpen,
      ownerPaneId: terminalOwnerPaneId,
    });
  });

  it.each([
    ["missing terminal", undefined],
    ["null terminal", null],
    ["non-object terminal", "closed"],
    ["missing open", { ownerPaneId: null }],
    ["missing owner", { open: false }],
    ["open without owner", { open: true, ownerPaneId: null }],
    ["closed with owner", { open: false, ownerPaneId: "primary" }],
    ["non-boolean open", { open: "yes", ownerPaneId: "primary" }],
    ["unknown owner", { open: true, ownerPaneId: "tertiary" }],
  ])("rejects malformed v4 terminal: %s", (_label, terminal) => {
    const record: Record<string, unknown> = { ...layout(), terminal };
    if (terminal === undefined) delete record.terminal;

    expect(parseWorkspaceLayout(JSON.stringify(record)).status).toBe("corrupt");
  });

  it("rejects extra nested terminal keys", () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          ...layout(),
          terminal: { open: false, ownerPaneId: null, runtime: true },
        }),
      ).status,
    ).toBe("corrupt");
  });

  it("normalizes an open secondary terminal closed when the secondary pane is closed", () => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify(
        layout({
          secondaryOpen: false,
          terminal: { open: true, ownerPaneId: "secondary" },
        }),
      ),
    );

    expect(parsed.status).toBe("valid");
    expect(parsed.layout.terminal).toEqual({ open: false, ownerPaneId: null });
  });

  it("round-trips whether the secondary pane is closed", () => {
    const closed = layout({
      secondaryOpen: false,
      focusedPaneId: "primary",
      panes: { primary: target("/a"), secondary: null },
    });
    const parsed = parseWorkspaceLayout(JSON.stringify(closed));

    expect(parsed.status).toBe("valid");
    expect(parsed.layout.secondaryOpen).toBe(false);
    expect(parsed.layout.focusedPaneId).toBe("primary");
    expect(parsed.layout.panes.secondary).toBeNull();
  });

  it("handles unavailable storage without throwing", () => {
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    };

    expect(loadWorkspaceLayout(unavailable, "main").status).toBe("corrupt");
    expect(saveWorkspaceLayout(unavailable, "main", layout())).toBe(false);
  });

  it("preserves rejected bytes under a diagnostic key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const raw = '{"version":99,"future":true}';
    values.set(workspaceLayoutKey("main"), raw);

    const loaded = loadWorkspaceLayout(storage, "main");
    expect(loaded.rejectedRaw).toBe(raw);
    expect(preserveRejectedWorkspaceLayout(storage, "main", loaded.rejectedRaw!)).toBe(true);
    expect(values.get(rejectedWorkspaceLayoutKey("main"))).toBe(raw);
  });

  it("serializes only allow-listed v4 fields and normalizes terminal ownership", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const dirty = {
      ...layout(),
      extra: "drop",
      terminal: { open: false, ownerPaneId: "secondary", runtime: "drop" },
    } as WorkspaceLayout;
    (dirty.panes.primary as object as Record<string, unknown>).extra = "drop";

    expect(saveWorkspaceLayout(storage, "main", dirty)).toBe(true);
    expect(JSON.parse(values.get(workspaceLayoutKey("main"))!)).toEqual(layout());
  });

  it("round-trips one native window under its own key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const saved = layout({ splitRatio: 63 });

    expect(saveWorkspaceLayout(storage, "project-2", saved)).toBe(true);
    expect(values.has(workspaceLayoutKey("project-2"))).toBe(true);
    expect(loadWorkspaceLayout(storage, "project-2")).toEqual({ layout: saved, status: "valid" });
  });
});

describe("workspace layout restore", () => {
  it("restores both existing project/session targets", async () => {
    const saved = layout({
      panes: {
        primary: target("/project/a", "/sessions/a.jsonl"),
        secondary: target("/project/b", "/sessions/b.jsonl"),
      },
    });
    const validate = vi.fn().mockResolvedValue({ projectExists: true, sessionExists: true });

    await expect(resolveWorkspaceLayoutTargets(saved, validate)).resolves.toEqual(saved);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("drops a missing project and starts cleanly when only its session is missing", async () => {
    const saved = layout({
      panes: {
        primary: target("/missing", "/sessions/missing.jsonl"),
        secondary: target("/project/b", "/sessions/gone.jsonl"),
      },
    });

    const restored = await resolveWorkspaceLayoutTargets(saved, async ({ cwd }) => ({
      projectExists: cwd !== "/missing",
      sessionExists: false,
    }));

    expect(restored.panes.primary).toBeNull();
    expect(restored.panes.secondary).toEqual(target("/project/b"));
  });

  it("contains validator failures to the affected pane", async () => {
    const saved = layout({
      panes: { primary: target("/project/a"), secondary: target("/project/b") },
    });

    const restored = await resolveWorkspaceLayoutTargets(saved, async ({ cwd }) => {
      if (cwd === "/project/a") throw new Error("native validation failed");
      return { projectExists: true, sessionExists: true };
    });

    expect(restored.panes.primary).toBeNull();
    expect(restored.panes.secondary).toEqual(target("/project/b"));
  });

  it("defensively falls back to primary focus for a closed secondary during resolution", async () => {
    const saved = layout({
      secondaryOpen: false,
      focusedPaneId: "secondary",
      panes: { primary: target("/project/a"), secondary: null },
    });

    const restored = await resolveWorkspaceLayoutTargets(saved, vi.fn());

    expect(restored.focusedPaneId).toBe("primary");
  });
});
