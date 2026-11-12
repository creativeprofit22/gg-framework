import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCi, LOCAL_FLAKY_NAMES, retryCount } from "./retry-policy.mjs";

describe("retry-policy", () => {
  it("retries twice on CI", () => {
    assert.equal(retryCount({ ci: true, name: "alone" }), 2);
    assert.equal(retryCount({ ci: true, name: "alone", flakyNames: ["alone"] }), 2);
  });

  it("does not retry locally", () => {
    assert.equal(retryCount({ ci: false, name: "alone" }), 0);
    assert.equal(retryCount({ ci: false, name: "alone", flakyNames: LOCAL_FLAKY_NAMES }), 0);
  });

  it("retries a named flaky test once locally", () => {
    assert.equal(retryCount({ ci: false, name: "alone", flakyNames: ["alone"] }), 1);
    assert.equal(retryCount({ ci: false, name: "other", flakyNames: ["alone"] }), 0);
  });

  it("reads CI from the environment", () => {
    assert.equal(isCi({ CI: "true" }), true);
    assert.equal(isCi({ CI: "1" }), true);
    assert.equal(isCi({ CONTINUOUS_INTEGRATION: "true" }), true);
    assert.equal(isCi({}), false);
    assert.equal(isCi({ CI: "false" }), false);
    assert.equal(isCi({ CI: "0", CONTINUOUS_INTEGRATION: "" }), false);
  });
});
