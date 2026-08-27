export const PACKAGE_TEST_TEMPLATE = `/*__GG_MARKER__*/
import assert from "node:assert/strict";
import test from "node:test";
import { parsePackageArguments } from "./package-tauri.mjs";

test("accepts only the configured package modes", () => {
  assert.deepEqual({ ...parsePackageArguments(["--target", "fixture"]) }, { calibrate: false, verify: false, target: "fixture" });
  assert.throws(() => parsePackageArguments(["--target", "fixture", "--target", "other"]));
  assert.throws(() => parsePackageArguments(["--target", "fixture", "--unknown"]));
});
`;
