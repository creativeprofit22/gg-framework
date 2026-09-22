// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useTaskActivity } from "./useTaskActivity";

it("retains the outcome until navigating to another session and keeps its event callback stable", () => {
  const hook = renderHook(({ epoch }) => useTaskActivity(epoch), { initialProps: { epoch: 0 } });
  const handle = hook.result.current.handleActivityEvent;
  act(() => handle({ type: "run_start", data: {} }));
  act(() => handle({ type: "run_end", data: { verification: "passed", verifiedChecks: 1 } }));
  expect(hook.result.current.activity.phase).toBe("done");
  hook.rerender({ epoch: 0 });
  expect(hook.result.current.activity.phase).toBe("done");
  hook.rerender({ epoch: 1 });
  expect(hook.result.current.activity.phase).toBe("idle");
  expect(hook.result.current.handleActivityEvent).toBe(handle);
});
