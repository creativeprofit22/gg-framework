import path from "node:path";
import { describe, expect, it } from "vitest";

describe("test run temp folder", () => {
  it("keeps edit telemetry inside this run's temp folder", () => {
    const runDir = process.env.GG_TEST_RUN_TEMP ?? "";
    const telemetryPath = process.env.GG_EDIT_TELEMETRY_PATH ?? "";
    expect(path.basename(runDir)).toMatch(/^ggt-/);
    expect(path.resolve(telemetryPath).startsWith(path.resolve(runDir) + path.sep)).toBe(true);
  });
});
