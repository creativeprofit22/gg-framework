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
  it("folds the details shut while they dissolve, so the chat does not jump", () => {
    const leaving = ruleBody(noticeStyles, ".chat-error-details.leaving");
    expect(leaving).toContain("chat-error-details-collapse var(--dur-dissolve)");
    expect(noticeStyles).toMatch(
      /@keyframes chat-error-details-collapse\s*\{[^@]*to\s*\{\s*grid-template-rows:\s*0fr;/,
    );
    expect(ruleBody(noticeStyles, ".chat-error-details")).toContain("display: grid;");
    expect(ruleBody(noticeStyles, ".chat-error-details-body")).toContain("min-height: 0;");
  });

  it("hides the details only once the fold has finished", () => {
    const exitMs = Number(noticeSource.match(/DETAILS_EXIT_MS = (\d+);/)?.[1]);
    const dissolveMs = Number(appStyles.match(/--dur-dissolve:\s*(\d+)ms;/)?.[1]);
    expect(exitMs).toBeGreaterThan(0);
    expect(exitMs).toBe(dissolveMs);
  });
});
