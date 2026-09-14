// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readExecutionDisplay, assertTranscriptIsolation } from "./programmatic-execution-smoke-checks.mjs";

describe("execution display readiness", () => {
  const summary = "Isolated fixture manifest inspected.";
  function documentWith(bodyText, evidence = true) {
    const doc = document.implementation.createHTMLDocument();
    if (evidence) {
      const section = doc.createElement("section");
      section.setAttribute("aria-label", "Task execution evidence");
      section.innerHTML = "<ul><li>Inferred, not confirmed: specialist claim</li><li>Checked directly: Tool read completed.</li></ul>";
      doc.body.appendChild(section);
    }
    // jsdom has no layout-backed innerText; supply the text the native WebView reveals.
    Object.defineProperty(doc.body, "innerText", { value: bodyText, configurable: true });
    return doc;
  }
  it("waits for the animated summary, not just the immediate evidence row", () => {
    expect(readExecutionDisplay(documentWith("Isolated fixture"), summary)).toBeNull();
    expect(readExecutionDisplay(documentWith(summary), summary)).toMatchObject({ summaryCount: 1, executableElements: 0, items: expect.any(Array) });
  });
  it("does not treat the summary without execution evidence as ready", () => {
    expect(readExecutionDisplay(documentWith(summary, false), summary)).toBeNull();
  });
  it("preserves duplicate counts so the caller's exact-one assertion fails", () => {
    expect(readExecutionDisplay(documentWith(`${summary}\n${summary}`), summary).summaryCount).toBe(2);
  });
});

describe("task transcript isolation", () => {
  const before = { "startup.jsonl": "unchanged", "host.jsonl": "before" };
  it("allows only the active host transcript to change", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "host.jsonl": "after" }, "host.jsonl")).not.toThrow();
  });
  it("rejects a new child transcript", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "child.jsonl": "new" }, "host.jsonl")).toThrow();
  });
  it("rejects changes to an earlier startup transcript", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "startup.jsonl": "changed" }, "host.jsonl")).toThrow();
  });
  it("rejects missing transcripts or an unidentified active host", () => {
    expect(() => assertTranscriptIsolation(before, { "host.jsonl": "after" }, "host.jsonl")).toThrow();
    expect(() => assertTranscriptIsolation(before, before, "unknown.jsonl")).toThrow();
  });
});
