import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baselineFile } from "../search-bench.mjs";

function summaryWith(sessions) {
  return {
    specVersion: 1,
    sessions,
    headlines: {
      baseline: [
        {
          id: "H1",
          status: "ok",
          metric: "calls_per_s",
          value: 19.1,
          launches: 10,
          sessions: 1,
          pilot: { cv: 0.05 },
          description: "warm",
        },
      ],
    },
  };
}

describe("baselineFile", () => {
  it("omits excluded sessions from provenance and the commit check", () => {
    const file = baselineFile(
      summaryWith([
        {
          session: "used",
          targets: [{ label: "baseline", commit: "aaa" }],
        },
        {
          session: "voided",
          excluded: "tree read before measuring",
          targets: [{ label: "baseline", commit: "bbb" }],
        },
      ]),
      "baseline",
    );
    assert.equal(file.commit, "aaa");
    assert.deepEqual(file.sessions, ["used"]);
    assert.deepEqual(file.excludedSessions, [
      { session: "voided", reason: "tree read before measuring" },
    ]);
    assert.equal(file.headlines.H1.value, 19.1);
  });
});
