import { describe, expect, it, vi } from "vitest";
import { finishEntrances } from "./finish-entrances";

function fakeAnimation(iterations: number): { animation: Animation; finish: () => void } {
  const finish = vi.fn();
  const animation = {
    effect: { getTiming: () => ({ iterations }) },
    finish,
  } as unknown as Animation;
  return { animation, finish };
}

describe("finishEntrances", () => {
  it("finishes one-shot entrances and leaves loops running", () => {
    const entrance = fakeAnimation(1);
    const spinner = fakeAnimation(Infinity);
    const root = {
      getAnimations: vi.fn(() => [entrance.animation, spinner.animation]),
    } as unknown as Element;
    finishEntrances([root, null]);
    expect(root.getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(entrance.finish).toHaveBeenCalledOnce();
    expect(spinner.finish).not.toHaveBeenCalled();
  });

  it("shrugs off an animation that refuses to finish", () => {
    const stuck = fakeAnimation(1);
    vi.mocked(stuck.finish).mockImplementation(() => {
      throw new DOMException("InvalidStateError");
    });
    const root = { getAnimations: () => [stuck.animation] } as unknown as Element;
    expect(() => finishEntrances([root])).not.toThrow();
  });
});
