// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { ThinkingOrb } from "./ActivityOrb";

it("reserves decorative geometry while loading and then renders the real animation", async () => {
  const { container, unmount } = render(
    <ThinkingOrb size={20} state="listening" aria-hidden="true" style={{ flexShrink: 0 }} />,
  );
  const placeholder = container.querySelector("span");
  expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
  expect(placeholder?.style.width).toBe("20px");
  expect(placeholder?.style.height).toBe("20px");
  await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
  expect(container.querySelector("canvas")?.style.width).toBe("20px");
  expect(container.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  unmount();
});
