import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatInterval,
  isScheduleDraft,
  parseScheduleCommand,
  scheduleSlotAtCaret,
  withInterval,
} from "./scheduleCommand";

/** Unwrap a success, failing loudly (with the error) if it parsed as an error. */
function ok(raw: string) {
  const result = parseScheduleCommand(raw);
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Unwrap an error, failing loudly if it unexpectedly parsed. */
function err(raw: string) {
  const result = parseScheduleCommand(raw);
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

describe("parseScheduleCommand", () => {
  it("parses a prompt and interval", () => {
    expect(ok("/schedule check the railway logs and fix any issues | 15m")).toEqual({
      prompt: "check the railway logs and fix any issues",
      intervalMs: 15 * 60_000,
      runCount: null,
    });
  });

  describe("pipes inside the prompt", () => {
    it("keeps a shell pipe intact by reading segments right-to-left", () => {
      // The whole reason for right-to-left parsing: a naive split on the first
      // "|" would truncate this prompt to "ps aux".
      expect(ok("/schedule ps aux | grep node | 15m")).toEqual({
        prompt: "ps aux | grep node",
        intervalMs: 15 * 60_000,
        runCount: null,
      });
    });

    it("keeps a shell pipe intact when a run count is present too", () => {
      expect(ok("/schedule ps aux | grep node | 30m | 10")).toEqual({
        prompt: "ps aux | grep node",
        intervalMs: 30 * 60_000,
        runCount: 10,
      });
    });

    it("preserves multiple pipes and original spacing byte-for-byte", () => {
      expect(ok("/schedule cat log.txt |  grep ERROR | wc -l | 1h").prompt).toBe(
        "cat log.txt |  grep ERROR | wc -l",
      );
    });
  });

  describe("interval formats", () => {
    it("parses combined hours and minutes", () => {
      expect(ok("/schedule run the full test suite | 1h30m").intervalMs).toBe(90 * 60_000);
    });

    it("parses hours only", () => {
      expect(ok("/schedule deploy | 2h").intervalMs).toBe(2 * 3_600_000);
    });

    it("tolerates internal whitespace and uppercase units", () => {
      expect(ok("/schedule deploy | 1H 30M").intervalMs).toBe(90 * 60_000);
    });

    it("rejects seconds", () => {
      const error = err("/schedule check logs | 15s");
      expect(error.code).toBe("invalid-interval");
      expect(error.message).toContain("15s");
    });

    it("rejects spelled-out units", () => {
      expect(err("/schedule check logs | 15 minutes").code).toBe("invalid-interval");
    });

    it("rejects a bare number with no unit", () => {
      // Two segments means the tail is the interval slot, never a run count.
      expect(err("/schedule check logs | 5").code).toBe("invalid-interval");
    });

    it("rejects zero with value-specific wording rather than a format hint", () => {
      const error = err("/schedule check logs | 0m");
      expect(error.code).toBe("invalid-interval");
      expect(error.message).toContain("greater than zero");
    });

    it("rejects a zero-valued combined interval", () => {
      expect(err("/schedule check logs | 0h0m").code).toBe("invalid-interval");
    });

    it("rejects a negative interval", () => {
      expect(err("/schedule check logs | -5m").code).toBe("invalid-interval");
    });
  });

  describe("run count", () => {
    it("defaults to null, meaning run until stopped", () => {
      expect(ok("/schedule check logs | 15m").runCount).toBeNull();
    });

    it("parses an explicit count", () => {
      expect(ok("/schedule check logs | 15m | 3").runCount).toBe(3);
    });

    it("accepts a count of 1", () => {
      expect(ok("/schedule check logs | 15m | 1").runCount).toBe(1);
    });

    it("rejects zero", () => {
      const error = err("/schedule check logs | 15m | 0");
      expect(error.code).toBe("invalid-count");
      expect(error.message).toContain("at least 1");
    });

    it("treats a negative count as an unparseable interval, not a count", () => {
      // "-5" is not a bare integer, so it stays in the interval slot and the
      // real interval "15m" is absorbed into the prompt.
      expect(err("/schedule check logs | 15m | -5").code).toBe("invalid-interval");
    });
  });

  describe("empty and missing input", () => {
    it("rejects an empty prompt before the interval", () => {
      const error = err("/schedule | 15m");
      expect(error.code).toBe("empty-prompt");
    });

    it("rejects a whitespace-only prompt", () => {
      expect(err("/schedule    | 15m").code).toBe("empty-prompt");
    });

    it("rejects the bare command", () => {
      expect(err("/schedule").code).toBe("empty");
    });

    it("rejects a prompt with no interval at all", () => {
      const error = err("/schedule check the railway logs");
      expect(error.code).toBe("missing-interval");
      expect(error.message).toContain("15m");
    });
  });

  describe("error ranges", () => {
    it("points at the bad interval segment only", () => {
      const raw = "/schedule check logs | 15s";
      const error = err(raw);
      expect(raw.slice(error.start, error.end)).toBe("15s");
    });

    it("points at the bad count segment only", () => {
      const raw = "/schedule check logs | 15m | 0";
      const error = err(raw);
      expect(raw.slice(error.start, error.end)).toBe("0");
    });

    it("points at the prompt when the interval is missing", () => {
      const raw = "/schedule check the railway logs";
      const error = err(raw);
      expect(raw.slice(error.start, error.end)).toBe("check the railway logs");
    });

    it("excludes surrounding whitespace from the highlight", () => {
      const raw = "/schedule check logs |    15s   ";
      const error = err(raw);
      expect(raw.slice(error.start, error.end)).toBe("15s");
    });
  });

  describe("command token handling", () => {
    it("parses without the leading command token, for mid-typing validation", () => {
      expect(ok("check logs | 15m")).toEqual({
        prompt: "check logs",
        intervalMs: 15 * 60_000,
        runCount: null,
      });
    });

    it("accepts the /sched alias", () => {
      expect(ok("/sched check logs | 15m").prompt).toBe("check logs");
    });

    it("does not treat /scheduler as the command token", () => {
      // No boundary after "/schedule", so the token stays part of the prompt.
      expect(ok("/scheduler notes | 15m").prompt).toBe("/scheduler notes");
    });

    it("tolerates leading whitespace", () => {
      expect(ok("   /schedule check logs | 15m").prompt).toBe("check logs");
    });
  });

  describe("trailing pipe mid-typing", () => {
    it("asks for a count rather than blaming the interval", () => {
      const error = err("/schedule check logs | 15m | ");
      expect(error.code).toBe("empty-count");
      expect(error.message).toContain("run count");
    });
  });
});

describe("isScheduleDraft", () => {
  it("is false until the space after the command is typed", () => {
    // Still a plain `/prefix`, so the normal command palette owns it.
    expect(isScheduleDraft("/schedu")).toBe(false);
    expect(isScheduleDraft("/schedule")).toBe(false);
  });

  it("is true once the argument region opens", () => {
    expect(isScheduleDraft("/schedule ")).toBe(true);
    expect(isScheduleDraft("/schedule check logs | 15m")).toBe(true);
  });

  it("accepts the alias and leading whitespace", () => {
    expect(isScheduleDraft("/sched x")).toBe(true);
    expect(isScheduleDraft("  /schedule x")).toBe(true);
  });

  it("is false for other commands and plain prose", () => {
    expect(isScheduleDraft("/plan something")).toBe(false);
    expect(isScheduleDraft("schedule a meeting")).toBe(false);
    expect(isScheduleDraft("/scheduler notes")).toBe(false);
  });
});

describe("scheduleSlotAtCaret", () => {
  it("reports the prompt before any pipe", () => {
    const raw = "/schedule check logs";
    expect(scheduleSlotAtCaret(raw, raw.length)).toBe("prompt");
  });

  it("reports the interval after the first pipe", () => {
    const raw = "/schedule check logs | 15m";
    expect(scheduleSlotAtCaret(raw, raw.length)).toBe("every");
  });

  it("reports the count after the second pipe", () => {
    const raw = "/schedule check logs | 15m | 10";
    expect(scheduleSlotAtCaret(raw, raw.length)).toBe("times");
  });

  it("switches slot the moment the pipe is typed", () => {
    const raw = "/schedule check logs |";
    expect(scheduleSlotAtCaret(raw, raw.length)).toBe("every");
  });

  it("keeps a shell pipe in the prompt slot", () => {
    // Caret after "grep node": the interval is claimed from the END, so this
    // middle segment is still prompt. The highlight must agree with the parser.
    const raw = "/schedule ps aux | grep node | 15m";
    expect(scheduleSlotAtCaret(raw, 28)).toBe("prompt");
  });

  it("clamps a caret past the end", () => {
    const raw = "/schedule check logs | 15m";
    expect(scheduleSlotAtCaret(raw, 9999)).toBe("every");
  });

  it("clamps a caret inside the command token to the prompt", () => {
    expect(scheduleSlotAtCaret("/schedule check logs | 15m", 2)).toBe("prompt");
  });
});

describe("formatInterval", () => {
  it("formats minutes", () => {
    expect(formatInterval(15 * 60_000)).toBe("15 min");
  });

  it("formats a single hour without pluralising", () => {
    expect(formatInterval(3_600_000)).toBe("1 hr");
  });

  it("formats combined hours and minutes", () => {
    expect(formatInterval(90 * 60_000)).toBe("1 hr 30 min");
  });

  it("pluralises multiple hours", () => {
    expect(formatInterval(6 * 3_600_000)).toBe("6 hrs");
  });

  it("never returns an empty string for a sub-minute duration", () => {
    // The parser can't produce these, but countdowns can — and an empty string
    // renders as "Every · until stopped".
    expect(formatInterval(2000)).toBe("2 sec");
    expect(formatInterval(100)).toBe("1 sec");
    expect(formatInterval(0)).toBe("1 sec");
  });
});

describe("describeSchedule", () => {
  it("describes an open-ended schedule", () => {
    expect(describeSchedule({ prompt: "x", intervalMs: 15 * 60_000, runCount: null })).toBe(
      "Every 15 min \u00b7 until stopped",
    );
  });

  it("describes a bounded schedule", () => {
    expect(describeSchedule({ prompt: "x", intervalMs: 3_600_000, runCount: 10 })).toBe(
      "Every 1 hr \u00b7 10 runs",
    );
  });

  it("does not pluralise a single run", () => {
    expect(describeSchedule({ prompt: "x", intervalMs: 3_600_000, runCount: 1 })).toBe(
      "Every 1 hr \u00b7 1 run",
    );
  });
});

describe("withInterval", () => {
  it("appends an interval when there is none", () => {
    expect(withInterval("/schedule check logs", "1h").text).toBe("/schedule check logs | 1h");
  });

  it("replaces an existing interval rather than adding a second bar", () => {
    expect(withInterval("/schedule check logs | 15m", "1h").text).toBe("/schedule check logs | 1h");
  });

  it("keeps the run count when replacing the interval", () => {
    expect(withInterval("/schedule check logs | 15m | 10", "6h").text).toBe(
      "/schedule check logs | 6h | 10",
    );
  });

  it("does not destroy a shell pipe in the prompt", () => {
    // Counting bars alone would treat "grep node" as the interval slot and
    // overwrite it, leaving the real interval behind.
    expect(withInterval("/schedule ps aux | grep node | 15m", "1h").text).toBe(
      "/schedule ps aux | grep node | 1h",
    );
  });

  it("keeps a shell pipe AND a run count", () => {
    expect(withInterval("/schedule ps aux | grep node | 15m | 10", "1h").text).toBe(
      "/schedule ps aux | grep node | 1h | 10",
    );
  });

  it("puts the caret after the filled interval", () => {
    const { text, caret } = withInterval("/schedule check logs | 15m | 10", "6h");
    expect(text.slice(0, caret)).toBe("/schedule check logs | 6h");
  });

  it("round-trips through the parser", () => {
    const { text } = withInterval("/schedule ps aux | grep node | 15m", "1h");
    const result = parseScheduleCommand(text);
    expect(result.ok && result.value.prompt).toBe("ps aux | grep node");
    expect(result.ok && result.value.intervalMs).toBe(3_600_000);
  });
});
