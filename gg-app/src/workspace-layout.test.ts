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
      version: 2,
      splitRatio: 90,
      secondaryOpen: true,
      panes: {
        primary: target("/project/a"),
        secondary: target("/project/b", "/sessions/b.jsonl"),
      },
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
    expect(result.layout.panes.secondary?.cwd).toBe("/project/b");
  });

  it("round-trips whether the secondary pane is closed", () => {
    const closed = layout({
      secondaryOpen: false,
      panes: { primary: target("/a"), secondary: null },
    });
    const parsed = parseWorkspaceLayout(JSON.stringify(closed));

    expect(parsed.status).toBe("valid");
    expect(parsed.layout.secondaryOpen).toBe(false);
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
});
