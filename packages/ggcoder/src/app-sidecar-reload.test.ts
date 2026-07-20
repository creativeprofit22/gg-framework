import { describe, expect, it } from "vitest";
import { AppSidecarReloadCoordinator } from "./app-sidecar-reload.js";

const session = (running: boolean) => ({ isRunning: () => running });

describe("AppSidecarReloadCoordinator", () => {
  it("rejects prepare and reload while any window session is running", () => {
    const reload = new AppSidecarReloadCoordinator();
    expect(reload.prepare([session(false), session(true)])).toEqual({
      ok: false,
      reason: "active-runs",
    });
    expect(reload.begin([session(false), session(true)])).toEqual({
      ok: false,
      reason: "active-runs",
    });
  });

  it("blocks mutations only during a prepared secret-free reload", () => {
    const reload = new AppSidecarReloadCoordinator();
    expect(reload.prepare([session(false), session(false)])).toEqual({ ok: true });
    expect(reload.shouldBlockSessionMutation("POST")).toBe(true);
    expect(reload.shouldBlockSessionMutation("GET")).toBe(false);
    expect(reload.begin([session(false), session(false)])).toEqual({ ok: true });
    expect(reload.shouldBlockSessionMutation("POST")).toBe(true);
  });

  it("cancels a reservation after native persistence fails", () => {
    const reload = new AppSidecarReloadCoordinator();
    expect(reload.prepare([])).toEqual({ ok: true });
    reload.cancel();
    expect(reload.shouldBlockSessionMutation("POST")).toBe(false);
    expect(reload.begin([])).toEqual({ ok: false, reason: "not-prepared" });
  });
});
