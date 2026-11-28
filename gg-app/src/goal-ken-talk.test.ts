import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
  KEN_LINE_MAX,
  PRIORITY,
  SPEAK_GAP_MS,
  STALE_MS,
  enqueue,
  hidePartialKenLine,
  latestKenLine,
  nextLine,
  ownLine,
  markHeard,
  noteLine,
  splitKenLine,
  stripKenLine,
  workerLine,
  type KenLine,
} from "./goal-ken-talk";

const line = (id: string, priority: number, extra: Partial<KenLine> = {}): KenLine => ({
  id,
  face: "neutral",
  text: id,
  priority,
  ...extra,
});

describe("splitKenLine", () => {
  it("takes Ken's spoken line off the end of a message, with its face", () => {
    const text =
      "## Results\n\n| Page | Before | After |\n|---|---|---|\n| Home | 1.4s | 0.9s |\n\n[ken:proud] 0.9 seconds on mobile. We beat the target.";
    const { body, line: said } = splitKenLine(text);
    expect(said).toEqual({ face: "proud", text: "0.9 seconds on mobile. We beat the target." });
    expect(body).toBe(
      "## Results\n\n| Page | Before | After |\n|---|---|---|\n| Home | 1.4s | 0.9s |",
    );
  });

  it("falls back to the neutral face for one it doesn't know, and cleans Markdown out", () => {
    expect(splitKenLine("Done.\n`[ken:Smug]` Shipped **all** of [it](https://x.y).").line).toEqual({
      face: "neutral",
      text: "Shipped all of it.",
    });
  });

  it("clips a long line at a word", () => {
    const said = splitKenLine(`[ken:happy] ${"word ".repeat(60)}`).line;
    expect(said?.text.length).toBeLessThanOrEqual(KEN_LINE_MAX);
    expect(said?.text.endsWith("…")).toBe(true);
  });

  it("leaves a message without a line alone", () => {
    expect(splitKenLine("Just text.")).toEqual({ body: "Just text.", line: null });
  });

  it("never shows a stray marker elsewhere in the chat, keeping its words", () => {
    // Live run: a message opened with a marker as well as ending with one.
    expect(
      splitKenLine("[ken:worried] Deploy is blocked.\n\nDetails.\n\n[ken:worried] Waiting on you."),
    ).toEqual({
      body: "Deploy is blocked.\n\nDetails.",
      line: { face: "worried", text: "Waiting on you." },
    });
    expect(splitKenLine("[ken:happy] early\n\nThen the real answer.").body).toBe(
      "early\n\nThen the real answer.",
    );
  });

  it("speaks a line that opens the message when none ends it", () => {
    // Live run: GG Goals led its final summary with the line, and the farm's
    // box stayed silent for the turn.
    const text =
      "[ken:happy] All three reports are written. Each is over 1,000 words.\n\nAll three are in reports/:\n\n- **solar.md**\n- **wind.md**";
    expect(splitKenLine(text)).toEqual({
      body: "All three reports are written. Each is over 1,000 words.\n\nAll three are in reports/:\n\n- **solar.md**\n- **wind.md**",
      line: { face: "happy", text: "All three reports are written. Each is over 1,000 words." },
    });
  });
});

describe("chat display", () => {
  it("never shows the marker, finished or half-streamed", () => {
    expect(stripKenLine("All set.\n[ken:happy] Done!")).toBe("All set.");
    expect(hidePartialKenLine("All set.\n[ke")).toBe("All set.");
    expect(hidePartialKenLine("All set.\n[ken:hap")).toBe("All set.");
    expect(hidePartialKenLine("All set.\n[ken:happy] Do")).toBe("All set.");
    expect(hidePartialKenLine("A list: [kept]")).toBe("A list: [kept]");
  });
});

describe("the talk queue", () => {
  it("says one line, then keeps quiet for the gap", () => {
    let q = enqueue(EMPTY_QUEUE, line("a", PRIORITY.own), 0);
    q = enqueue(q, line("b", PRIORITY.finished), 0);
    const first = nextLine(q, 1000, false);
    expect(first.line?.id).toBe("a");
    expect(nextLine(first.queue, 1000 + SPEAK_GAP_MS - 1, false).line).toBeNull();
    expect(nextLine(first.queue, 1000 + SPEAK_GAP_MS, false).line?.id).toBe("b");
  });

  it("says nothing while the box is busy", () => {
    const q = enqueue(EMPTY_QUEUE, line("a", PRIORITY.own), 0);
    expect(nextLine(q, 0, true).line).toBeNull();
  });

  it("puts the most important line first", () => {
    let q = enqueue(EMPTY_QUEUE, line("done", PRIORITY.finished), 0);
    q = enqueue(q, line("own", PRIORITY.own), 0);
    q = enqueue(q, line("fail", PRIORITY.failed), 0);
    expect(nextLine(q, 0, false).line?.id).toBe("fail");
  });

  it("keeps only the newest waiting line of a kind, and never repeats one", () => {
    let q = enqueue(EMPTY_QUEUE, line("old", PRIORITY.own), 0);
    q = enqueue(q, line("new", PRIORITY.own), 5);
    expect(q.waiting.map((w) => w.line.id)).toEqual(["new"]);
    const said = nextLine(q, 10, false);
    expect(enqueue(said.queue, line("new", PRIORITY.own), 20).waiting).toHaveLength(0);
  });

  it("drops stale lines unsaid", () => {
    const q = enqueue(EMPTY_QUEUE, line("old", PRIORITY.own), 0);
    const later = nextLine(q, STALE_MS + 1, false);
    expect(later.line).toBeNull();
    expect(later.queue.waiting).toHaveLength(0);
  });

  it("never says what was already true when the farm opened", () => {
    const q = markHeard(EMPTY_QUEUE, ["own:3"]);
    expect(enqueue(q, line("own:3", PRIORITY.own), 0).waiting).toHaveLength(0);
  });
});

describe("event lines", () => {
  it("names the real worker, with a face to match", () => {
    const done = workerLine({ key: "w1", name: "Builder", to: "done" });
    expect(done.text).toContain("Builder");
    expect(done.face).toBe("happy");
    const failed = workerLine({ key: "w1", name: "Scout", to: "error" });
    expect(failed.text).toContain("Scout");
    expect(failed.face).toBe("worried");
    expect(failed.priority).toBeGreaterThan(done.priority);
  });

  it("gives each of Ken's messages its own line", () => {
    expect(ownLine({ messageId: 7, face: "happy", text: "Hi" })).toMatchObject({
      id: "own:7",
      priority: PRIORITY.own,
    });
  });

  it("finds the line on GG Goals' latest reply only", () => {
    expect(
      latestKenLine([
        { kind: "assistant", id: 1, text: "Old.\n[ken:sad] Old news." },
        { kind: "assistant", id: 2, text: "New.\n[ken:happy] All done." },
      ]),
    ).toEqual({ messageId: 2, face: "happy", text: "All done.", priority: PRIORITY.own });
  });

  it("never reads a reply that is still streaming", () => {
    const items = [
      { kind: "assistant" as const, id: 1, text: "Earlier.\n[ken:happy] Done before." },
      { kind: "assistant" as const, id: 2, text: "I trimmed" },
    ];
    expect(latestKenLine(items, (id) => id === 2)?.messageId).toBe(1);
    expect(latestKenLine(items)?.text).toBe("I trimmed");
  });

  it("says a short progress note as it is, but never a long or structured one", () => {
    const note =
      "All 24 tests pass. Now the README: one short example for each of the 21 functions.";
    expect(latestKenLine([{ kind: "assistant", id: 3, text: note }])).toEqual({
      messageId: 3,
      face: "focused",
      text: note,
      priority: PRIORITY.note,
    });
    expect(noteLine("`npm test` passes. Next, the **docs**.")).toBe(
      "npm test passes. Next, the docs.",
    );
    expect(noteLine("x ".repeat(100))).toBeNull();
    expect(noteLine("Done:\n\n- one\n- two")).toBeNull();
    expect(noteLine("Results:\n| a | b |")).toBeNull();
    expect(noteLine("Here:\n```js\nx()\n```")).toBeNull();
    expect(
      latestKenLine([
        { kind: "assistant", id: 1, text: "Short note." },
        { kind: "assistant", id: 2, text: "# Report\n\nA long structured report." },
      ]),
    ).toBeNull();
  });
});
