import { describe, expect, it, vi } from "vitest";

import { listingRouteResponse } from "./app-sidecar-listing-route.js";

describe("listingRouteResponse", () => {
  it("returns 200 with the listing under its key", async () => {
    const onError = vi.fn();

    const result = await listingRouteResponse("sessions", async () => [{ id: "a" }], onError);

    expect(result).toEqual({ status: 200, body: { sessions: [{ id: "a" }] } });
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns 500 with an error field and logs when listing throws", async () => {
    const onError = vi.fn();

    const result = await listingRouteResponse(
      "sessions",
      async () => {
        throw new Error("EACCES: permission denied, scandir sessions");
      },
      onError,
    );

    expect(result).toEqual({
      status: 500,
      body: { error: "EACCES: permission denied, scandir sessions" },
    });
    expect(onError).toHaveBeenCalledWith("EACCES: permission denied, scandir sessions");
  });

  it("does not report an empty project list when discovery rejects", async () => {
    const result = await listingRouteResponse(
      "projects",
      () => Promise.reject("bad settings"),
      () => {},
    );

    expect(result).toEqual({ status: 500, body: { error: "bad settings" } });
  });
});
