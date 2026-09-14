import { beforeEach, expect, it, vi } from "vitest";
import { createProgrammaticReadinessReader } from "../command-discovery.js";
import { assessProgrammaticSetup, loadApprovedProgrammaticProfile } from "./profile.js";
vi.mock("./profile.js", () => ({ assessProgrammaticSetup: vi.fn(), loadApprovedProgrammaticProfile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("does not inventory missing setup and shares concurrent readiness requests only", async () => {
  vi.mocked(loadApprovedProgrammaticProfile).mockResolvedValue(null);
  const read = createProgrammaticReadinessReader("fixture");
  const first = read();
  expect(read()).toBe(first);
  expect(await first).toBe("missing");
  expect(loadApprovedProgrammaticProfile).toHaveBeenCalledOnce();
  expect(assessProgrammaticSetup).not.toHaveBeenCalled();
  await read();
  expect(loadApprovedProgrammaticProfile).toHaveBeenCalledTimes(2);
});
it("reassesses legacy and unreadable profiles rather than caching a false-ready result", async () => {
  vi.mocked(loadApprovedProgrammaticProfile).mockRejectedValue(new Error("fixture legacy"));
  vi.mocked(assessProgrammaticSetup).mockResolvedValue({ status: "refresh-required" } as Awaited<ReturnType<typeof assessProgrammaticSetup>>);
  const read = createProgrammaticReadinessReader("fixture");
  expect(await read()).toBe("refresh-required");
  vi.mocked(assessProgrammaticSetup).mockRejectedValue(new Error("fixture unreadable"));
  expect(await read()).toBe("unreadable");
});
