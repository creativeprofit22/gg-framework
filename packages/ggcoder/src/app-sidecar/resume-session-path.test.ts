import { describe, expect, it, vi } from "vitest";
import { resolveResumeSessionPath } from "./resume-session-path.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const noSleep = () => Promise.resolve();

describe("resolveResumeSessionPath", () => {
  it("starts fresh when no session path was requested", async () => {
    const access = vi.fn(async () => {});
    expect(await resolveResumeSessionPath(undefined, { access, sleep: noSleep })).toBeUndefined();
    expect(access).not.toHaveBeenCalled();
  });

  it("resumes a session file that exists", async () => {
    expect(
      await resolveResumeSessionPath("s.jsonl", { access: async () => {}, sleep: noSleep }),
    ).toBe("s.jsonl");
  });

  it("starts fresh only when the file stays missing", async () => {
    const access = vi.fn(async () => {
      throw errno("ENOENT");
    });
    expect(
      await resolveResumeSessionPath("gone.jsonl", { access, sleep: noSleep, attempts: 4 }),
    ).toBeUndefined();
    expect(access).toHaveBeenCalledTimes(4);
  });

  // Regression: a Windows replace can delete the old file before renaming the
  // new copy into place. A reopen landing in that window must not silently
  // open an empty conversation instead of the saved one.
  it("resumes a file that is briefly missing while it is being replaced", async () => {
    let calls = 0;
    const access = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw errno("ENOENT");
    });
    expect(
      await resolveResumeSessionPath("s.jsonl", { access, sleep: noSleep, attempts: 4 }),
    ).toBe("s.jsonl");
  });

  it("resumes a file that is locked or pending replacement", async () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      const access = vi.fn(async () => {
        throw errno(code);
      });
      expect(
        await resolveResumeSessionPath("s.jsonl", { access, sleep: noSleep, attempts: 4 }),
      ).toBe("s.jsonl");
    }
  });
});
