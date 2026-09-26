import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { useThinkingLevel } from "./useThinkingLevel.js";
import { getNextThinkingLevel, isThinkingLevelSupported } from "../thinking-level.js";
import { getThinkingFooterLabel } from "../components/Footer.js";
import { ScreenRecorder, makeRecordingStdout } from "../testing/screen-recorder.js";

function harness() {
  let state!: ReturnType<typeof useThinkingLevel>;
  const renders: Array<{ model: string; level: ThinkingLevel | undefined }> = [];
  function Harness({ provider, model, initial }: {
    provider: Provider; model: string; initial?: ThinkingLevel;
  }) {
    state = useThinkingLevel(provider, model, initial);
    renders.push({ model, level: state[0] });
    return null;
  }
  const mounted = render(<Harness provider="anthropic" model="claude-opus-5" />, {
    stdout: makeRecordingStdout(new ScreenRecorder({ columns: 100, rows: 24 })),
    patchConsole: false,
  });
  return { mounted, Harness, renders, get state() { return state; } };
}

describe("terminal model-switch thinking state", () => {
  it("switches off to Qwen GLM5.3 without exposing off to runtime or status consumers", async () => {
    const h = harness();
    try {
      await vi.waitFor(() => expect(h.renders.length).toBeGreaterThan(0));
      expect(h.state[0]).toBeUndefined();
      h.mounted.rerender(<h.Harness provider="qwen-cloud" model="qwen-cloud/glm-5.3" />);
      await vi.waitFor(() => expect(h.state[0]).toBe("high"));
      expect(h.renders.filter(({ model }) => model === "qwen-cloud/glm-5.3").every(({ level }) =>
        !!level && isThinkingLevelSupported("qwen-cloud", "qwen-cloud/glm-5.3", level),
      )).toBe(true);
      expect(getThinkingFooterLabel(h.state[0], "qwen-cloud/glm-5.3")).toBe("Thinking high");
      for (const expected of ["max", "low", "high", "max"] as const) {
        h.state[1]((prev) => getNextThinkingLevel("qwen-cloud", "qwen-cloud/glm-5.3", prev));
        await vi.waitFor(() => expect(h.state[0]).toBe(expected));
      }
    } finally { h.mounted.unmount(); }
  });

  it("normalizes initial/remounted off and invalid saved levels", async () => {
    const h = harness();
    try {
      h.mounted.rerender(<h.Harness key="initial" provider="qwen-cloud" model="qwen-cloud/glm-5.3" />);
      await vi.waitFor(() => expect(h.state[0]).toBe("high"));
      h.mounted.rerender(<h.Harness key="remount" provider="qwen-cloud" model="qwen-cloud/glm-5.3" initial="ultra" />);
      await vi.waitFor(() => expect(h.state[0]).toBe("low"));
      h.mounted.rerender(<h.Harness key="legal" provider="qwen-cloud" model="qwen-cloud/glm-5.3" initial="max" />);
      await vi.waitFor(() => expect(h.state[0]).toBe("max"));
    } finally { h.mounted.unmount(); }
  });

  it.each(["qwen-cloud/qwen3.7-max", "qwen-cloud/qwen3.6-flash"])("keeps binary %s on/off", async (model) => {
    const h = harness();
    try {
      h.mounted.rerender(<h.Harness provider="qwen-cloud" model={model} />);
      await vi.waitFor(() => expect(h.renders.at(-1)?.model).toBe(model));
      expect(h.state[0]).toBeUndefined();
      expect(getThinkingFooterLabel(h.state[0], model)).toBe("Thinking off");
      h.state[1]((prev) => getNextThinkingLevel("qwen-cloud", model, prev));
      await vi.waitFor(() => expect(h.state[0]).toBe("high"));
      expect(getThinkingFooterLabel(h.state[0], model)).toBe("Thinking on");
      h.state[1]((prev) => getNextThinkingLevel("qwen-cloud", model, prev));
      await vi.waitFor(() => expect(h.state[0]).toBeUndefined());
      expect(getThinkingFooterLabel(h.state[0], model)).toBe("Thinking off");
    } finally { h.mounted.unmount(); }
  });
});
