import assert from "node:assert/strict";

// Self-contained: the native fixture evaluates this exact function in its WebView.
export function readExecutionDisplay(document, summary) {
  const section = document.querySelector('[aria-label="Task execution evidence"]');
  // Evidence renders immediately; streamed Markdown reveals its text on later frames.
  const summaryCount = document.body.innerText.split(summary).length - 1;
  if (!section || summaryCount === 0) return null;
  return {
    text: section.textContent,
    items: Array.from(section.querySelectorAll("li")).map((item) => item.textContent),
    executableElements: section.querySelectorAll("a,script,iframe,img").length,
    summaryCount,
  };
}

export function assertTranscriptIsolation(before, after, hostTranscript) {
  assert.ok(Object.hasOwn(before, hostTranscript), "Active host transcript identified before execution");
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "Execution must not create or remove a transcript");
  for (const [file, hash] of Object.entries(before)) {
    if (file !== hostTranscript) assert.equal(after[file], hash, "Execution must not modify another host transcript");
  }
}
