import { describe, expect, it } from "vitest";
import { annotateSandboxDenial, describeSandboxDenial } from "./sandbox-feedback.js";

describe("describeSandboxDenial", () => {
  it("names the blocked host and the one place a user can approve it", () => {
    const output =
      "Exit code: 0\ncurl: (56) CONNECT tunnel failed, response 403\nCONNECT api.example.com:443";

    const denial = describeSandboxDenial(output, true);

    expect(denial?.kind).toBe("network");
    expect(denial?.note).toContain("api.example.com");
    expect(denial?.note).toContain("Approved sites");
    // The model must not be told to silently give up or disable protection first.
    expect(denial?.note).toContain("ask them");
  });

  it("points a blocked write back inside the project", () => {
    const output = "touch: /Users/x/secret: Operation not permitted";

    const denial = describeSandboxDenial(output, true);

    expect(denial?.kind).toBe("filesystem");
    expect(denial?.note).toContain("outside this project");
  });

  it("stays silent for ordinary failures and for unsandboxed commands", () => {
    expect(describeSandboxDenial("Exit code: 1\nnpm ERR! missing script: buil", true)).toBeNull();
    // Same text, but the command never ran isolated — the sandbox cannot be the cause.
    expect(describeSandboxDenial("Operation not permitted", false)).toBeNull();
  });

  it("annotates output without discarding the original text", () => {
    const output = "Exit code: 0\nConnection blocked by network allowlist";

    const annotated = annotateSandboxDenial(output, true);

    expect(annotated.startsWith(output)).toBe(true);
    expect(annotated).toContain("[Sandbox]");
    expect(annotateSandboxDenial(output, false)).toBe(output);
  });
});
