import { expect, it } from "vitest";
import { queuedPromptMetadataRoundTrip, queuedSegments } from "./test-support/queued-prompt-metadata.js";

it.each([
  ["steering", false], ["stranded", false], ["steering", true], ["stranded", true],
] as const)("restores exact queued display hints through %s after cancellation (attachment=%s)", async (mode, withAttachment) => {
  const { history, modelMessages, hintsBeforeConsumption } = await queuedPromptMetadataRoundTrip(mode, withAttachment);
  expect(history.find((row) => row.text === "Use TypeScript")?.images?.length ?? 0).toBe(withAttachment ? 1 : 0);
  expect(hintsBeforeConsumption).toHaveLength(1); // Only the idle control, never guessed queue anchors.
  expect(JSON.stringify(modelMessages)).not.toMatch(/kenSent|enhancements|type script|Language name/);
  expect(JSON.stringify(modelMessages)).not.toContain("Cancelled prompt");
  expect(history.filter((row) => row.role === "user").map(({ text, kenSent, enhancements }) => ({
    text, kenSent, enhancements,
  }))).toEqual([
    { text: "Idle control", kenSent: true, enhancements: undefined },
    { text: "Use TypeScript", kenSent: undefined, enhancements: queuedSegments },
    { text: "Ken queued prompt", kenSent: true, enhancements: undefined },
  ]);
}, 60_000);
