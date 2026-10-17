import { describe, it, expect } from "vitest";
import { buildEnvDeltaMessage, fingerprintEnvironment } from "./env-delta.js";

describe("buildEnvDeltaMessage", () => {
  it("says nothing when the environment has not moved", () => {
    const env = { additionalRoots: ["/a"], networkAllow: ["example.com"] };

    expect(buildEnvDeltaMessage(env, { ...env })).toBeNull();
  });

  it("says nothing for two empty environments", () => {
    expect(buildEnvDeltaMessage({}, {})).toBeNull();
  });

  it("reports a network allowlist that changed after the prompt was written", () => {
    const message = buildEnvDeltaMessage(
      { networkAllow: ["old.example.com"] },
      { networkAllow: ["new.example.com", "api.example.com"] },
    );

    expect(message?.content).toContain("new.example.com, api.example.com");
    expect(message?.content).not.toContain("old.example.com");
  });

  it("reports an allowlist that stopped restricting hosts", () => {
    const message = buildEnvDeltaMessage({ networkAllow: ["old.example.com"] }, {});

    expect(message?.content).toContain("no longer restricts");
  });

  it("reports changed roots", () => {
    const message = buildEnvDeltaMessage(
      { additionalRoots: ["/one"] },
      { additionalRoots: ["/one", "/two"] },
    );

    expect(message?.content).toContain("/one, /two");
  });

  it("mentions only the fact that changed, so the note stays small", () => {
    const message = buildEnvDeltaMessage(
      { additionalRoots: ["/one"], networkAllow: ["a.example.com"] },
      { additionalRoots: ["/one"], networkAllow: ["b.example.com"] },
    );

    expect(message?.content).toContain("b.example.com");
    expect(message?.content).not.toContain("Additional roots");
  });

  it("stays hidden from the transcript and reads as runtime, not as the user", () => {
    const message = buildEnvDeltaMessage({}, { networkAllow: ["example.com"] });

    expect(message?.provenance).toMatchObject({ source: "runtime", visibility: "hidden" });
  });

  it("is small enough to be cheaper than re-rendering the prompt", () => {
    const message = buildEnvDeltaMessage({}, { networkAllow: ["example.com"] });

    // ~4 chars per token: a few hundred chars is tens of tokens, against the
    // thousands a prompt rebuild invalidates.
    expect((message?.content as string).length).toBeLessThan(500);
  });

  it("treats reordering as a change rather than pretending nothing happened", () => {
    const message = buildEnvDeltaMessage(
      { networkAllow: ["a.example.com", "b.example.com"] },
      { networkAllow: ["b.example.com", "a.example.com"] },
    );

    expect(message).not.toBeNull();
  });
});

describe("fingerprintEnvironment", () => {
  it("matches for equal environments and differs for changed ones", () => {
    expect(fingerprintEnvironment({ networkAllow: ["a"] })).toBe(
      fingerprintEnvironment({ networkAllow: ["a"] }),
    );
    expect(fingerprintEnvironment({ networkAllow: ["a"] })).not.toBe(
      fingerprintEnvironment({ networkAllow: ["b"] }),
    );
  });

  it("ignores absent-vs-empty so a fresh session does not self-trigger", () => {
    expect(fingerprintEnvironment({})).toBe(
      fingerprintEnvironment({ additionalRoots: [], networkAllow: [] }),
    );
  });
});
