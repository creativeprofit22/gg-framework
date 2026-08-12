import { describe, expect, it } from "vitest";
import {
  parsePhaseAdvancementStartBody,
  parsePhaseAdvancementStartRoute,
} from "./app-sidecar-phase-advancement-route.js";

describe("phase advancement start route", () => {
  it("decodes opaque checkpoint IDs and ignores query strings", () => {
    expect(
      parsePhaseAdvancementStartRoute(
        "POST",
        "/notes/roadmap/advancement/checkpoint%3Aopaque/start?window=two",
      ),
    ).toEqual({ checkpointId: "checkpoint:opaque" });
  });

  it.each([
    ["GET", "/notes/roadmap/advancement/checkpoint/start"],
    ["POST", "/notes/roadmap/advancement//start"],
    ["POST", "/notes/roadmap/advancement/%E0%A4%A/start"],
    ["POST", "/notes/roadmap/advancement/checkpoint/other"],
  ])("rejects non-matching or malformed routes", (method, url) => {
    expect(parsePhaseAdvancementStartRoute(method, url)).toBeNull();
  });

  it("accepts only the fixed human confirmation body", () => {
    expect(
      parsePhaseAdvancementStartBody({
        action: "start-next-phase",
        nextPhaseId: "phase-next",
      }),
    ).toEqual({ action: "start-next-phase", nextPhaseId: "phase-next" });
  });

  it.each([
    null,
    {},
    { action: "start-next-phase" },
    { action: "launch", nextPhaseId: "phase-next" },
    { action: "start-next-phase", nextPhaseId: "" },
    { action: "start-next-phase", nextPhaseId: "phase-next", operationId: "forged" },
  ])("rejects bodies that could weaken or forge confirmation authority", (body) => {
    expect(parsePhaseAdvancementStartBody(body)).toBeNull();
  });
});
