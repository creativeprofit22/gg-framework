import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Match the other CSS tests: Vite stubs stylesheets in browser-environment tests.
const noticeStyles = readFileSync(new URL("../src/ChatErrorNotice.css", import.meta.url), "utf8");
const noticeSource = readFileSync(new URL("../src/ChatErrorNotice.tsx", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

const ruleBody = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? undefined : css.slice(at, css.indexOf("}", at));
};

describe("chat error details exit", () => {
  it("measures the fold including padding and uses distinct sharp opacity exits", () => {
    expect(noticeSource).toContain("useAnimatedHeight(detailsRef, expanded, error)");
    expect(ruleBody(noticeStyles, ".chat-error-details")).toContain("overflow: hidden;");
    expect(ruleBody(noticeStyles, ".chat-error-details-body")).toContain(
      "padding-top: var(--space-4)",
    );
    expect(
      ruleBody(noticeStyles, ".chat-error-details.leaving .chat-error-details-body"),
    ).toContain("details-out var(--dur-row)");
    expect(noticeStyles).not.toMatch(/reverse|blur\(/);
  });

  it("hides the details only once the fold has finished", () => {
    const exitMs = Number(noticeSource.match(/DETAILS_EXIT_MS = (\d+);/)?.[1]);
    const dissolveMs = Number(appStyles.match(/--dur-row:\s*(\d+)ms;/)?.[1]);
    expect(exitMs).toBeGreaterThan(0);
    expect(exitMs).toBe(dissolveMs);
  });
});

describe("chat error layout", () => {
  it("stays one column: nothing is placed in a column the grid no longer has", () => {
    // The notice was 28px art + text; the art is gone. A leftover
    // `grid-column: 2 / …` puts the details beside the copy, squeezing the
    // copy into a sliver.
    expect(ruleBody(noticeStyles, ".chat-error-notice")).toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
    expect(noticeStyles).not.toMatch(/grid-column:\s*[2-9]/);
  });
});
