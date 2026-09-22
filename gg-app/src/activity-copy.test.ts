import { describe, expect, it } from "vitest";
import { OUTCOME_PHRASES, outcomePhrase } from "./activity-copy";

describe("GG outcome wording", () => {
  it.each(Object.entries(OUTCOME_PHRASES))(
    "keeps %s concise, varied and stable",
    (label, phrases) => {
      expect(new Set(phrases).size).toBeGreaterThanOrEqual(6);
      for (const phrase of phrases) {
        expect(phrase.length).toBeGreaterThanOrEqual(12);
        expect(phrase.length).toBeLessThanOrEqual(26);
        expect(phrase).not.toMatch(/[\n\r]|shipped|production.ready|all done|everything passed/i);
      }
      expect(
        Math.max(...phrases.map((p) => p.length)) - Math.min(...phrases.map((p) => p.length)),
      ).toBeLessThanOrEqual(10);
      for (let seed = 0; seed < phrases.length; seed++) {
        expect(outcomePhrase(label, seed)).toBe(phrases[seed]);
        expect(outcomePhrase(label, seed)).toBe(outcomePhrase(label, seed));
      }
    },
  );
  it("leaves event labels outside the outcome pools alone", () => {
    expect(outcomePhrase("Retrying…", 42)).toBeUndefined();
    expect(outcomePhrase("Working…", 42)).toBeUndefined();
  });
  it("never substitutes green language for failure or missing verification", () => {
    for (const label of [
      "Checks failed",
      "Verification incomplete",
      "Task failed",
      "Ken’s review failed",
    ]) {
      for (const phrase of OUTCOME_PHRASES[label]!)
        expect(phrase).not.toMatch(/passed|green|ready|success/i);
    }
  });
});
