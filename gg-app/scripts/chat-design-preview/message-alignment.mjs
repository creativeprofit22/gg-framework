import assert from "node:assert/strict";
import { capturePreview } from "./run.mjs";

// Browser-only regression: real message components, synthetic sessions.
for (const [variant, layout, width, height, state] of [
  ["light", "one", 1280, 800, "completed"],
  ["light", "one", 390, 844, "completed"],
  ["light", "six", 2560, 1400, "completed"],
  ["light", "one", 1280, 800, "variants"],
  ["original", "one", 1280, 800, "completed"],
]) {
  await capturePreview({ variant, layout, width, height, state, verify: async (page) => {
    await page.locator(".user-msg").first().waitFor();
    await page.evaluate(() => document.querySelectorAll(".transcript").forEach((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    }));
    const measurements = await page.locator(".workspace-pane-slot").evaluateAll((panes) => panes.map((pane) => {
      const assistant = pane.querySelector(".assistant-text");
      const transcript = pane.querySelector(".transcript");
      const assistantLeft = assistant?.getBoundingClientRect().left;
      return {
        assistantLeft,
        transcriptLeft: transcript.getBoundingClientRect().left,
        transcriptRight: transcript.getBoundingClientRect().right,
        messages: [...pane.querySelectorAll(".user-msg")].map((message) => {
          const style = getComputedStyle(message);
          const rect = message.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            textLeft: rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
            background: style.backgroundColor,
            radius: parseFloat(style.borderRadius),
          };
        }),
      };
    }));
    for (const pane of measurements) {
      assert(pane.messages.length > 0);
      for (const message of pane.messages) {
        assert(message.left >= pane.transcriptLeft);
        assert(message.right <= pane.transcriptRight + 1);
        assert(message.radius > 0, "Preserve the bubble wrapper");
        if (variant === "light" && pane.assistantLeft !== undefined) {
          assert(Math.abs(message.textLeft - pane.assistantLeft) <= 1, "User and assistant text share a left rail");
        }
      }
      if (variant === "original") {
        assert(pane.messages[0].textLeft > pane.assistantLeft + 100, "Original comparison remains right-aligned");
      }
    }
    return { variant, state, measurements };
  } });
}
