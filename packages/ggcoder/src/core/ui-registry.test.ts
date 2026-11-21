import { describe, expect, it, vi } from "vitest";
import {
  UiRegistry,
  registryKey,
  registryPath,
  registryUrl,
  validateRegistryItem,
} from "./ui-registry.js";

const item = {
  name: "card",
  type: "registry:ui",
  files: [{ path: "/ui/card.tsx", target: "", content: "export const Card = () => null;" }],
};

describe("public UI registry", () => {
  it("accepts conventional source paths and empty targets, rejects malformed schemas", () => {
    expect(validateRegistryItem(item, true).files[0].target).toBe("");
    expect(registryPath("/ui/card.tsx")).toBe("ui/card.tsx");
    for (const input of ["../x", "a/../../x", "//etc/x", "C:\\x", ""])
      expect(() => registryPath(input)).toThrow();
    expect(() =>
      validateRegistryItem({ ...item, scripts: { postinstall: "unexpected" } }),
    ).toThrow();
    expect(() => validateRegistryItem({ ...item, files: [{ path: "x" }] }, true)).toThrow();
  });

  it("allows only exact public paths without credentials or query strings", () => {
    expect(registryKey("@bklit/card")).toBe("bklit:card");
    expect(registryKey("https://kokonutui.com/r/card.json")).toBe("kokonut:card");
    for (const url of [
      "http://ui.bklit.com/r/card.json",
      "https://ui.bklit.com/private",
      "https://user@ui.bklit.com/r/card.json",
      "https://ui.bklit.com/r/card.json?q=1",
      "https://raw.githubusercontent.com/private/repo/main/file",
      "https://ui.bklit.com/r/%2e%2e/card.json",
    ])
      expect(() => registryUrl(url)).toThrow();
  });

  it("revalidates redirects and does not fetch a denied destination", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://example.com/private" } }),
      );
    await expect(new UiRegistry(undefined, fetcher).inspect("bklit:card")).rejects.toThrow(
      /Blocked/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("is lazy, bounds payloads and records hosted hash separately from revision", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(item)));
    const registry = new UiRegistry(undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await registry.inspect("bklit:card");
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.hostedMatchesRevision).toBe("not-verified");
    await registry.inspect("bklit:card");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response("x".repeat(3000001)));
    await expect(registry.inspect("bklit:other")).rejects.toThrow(/3 MB/);
  });

  it("rejects cycles and honors cancellation before network access", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ ...item, registryDependencies: ["@bklit/card"] })),
      );
    const registry = new UiRegistry(undefined, fetcher);
    await expect(registry.closure("bklit:card")).rejects.toThrow(/cycle/);
    const controller = new AbortController();
    controller.abort();
    await expect(registry.inspect("bklit:card", controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
