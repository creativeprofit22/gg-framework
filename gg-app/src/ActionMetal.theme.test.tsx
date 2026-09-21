// @vitest-environment jsdom
// JSDOM cannot run WebGL. This checks the shader prop boundary; the adjacent
// suite uses the real package fallback, and the native smoke covers WebGL.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMetal } from "./ActionMetal";
import { appearance } from "./appearance";
vi.mock("metal-fx", () => ({ MetalFx: ({ theme, children }: { theme: string; children: React.ReactNode }) => <div className="action-metal" data-theme={theme}>{children}</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("passes the saved theme to the shader without replacing its host", async () => {
  localStorage.clear(); appearance.reset();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const { container } = render(<ActionMetal active windowFocused />);
  await waitFor(() => expect(container.querySelector(".action-metal")?.getAttribute("data-theme")).toBe("dark"));
  const host = container.querySelector(".action-metal");
  act(() => appearance.update({ theme: "light" }));
  expect(container.querySelector(".action-metal")).toBe(host);
  expect(host?.getAttribute("data-theme")).toBe("light");
});
