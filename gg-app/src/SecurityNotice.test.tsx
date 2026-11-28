// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeSecurityBlock, SecurityNotice } from "./SecurityNotice";

describe("security chat row", () => {
  it("says what was blocked and why, in plain words", () => {
    expect(describeSecurityBlock("malicious-package", "npm install chalk@5.6.1")).toBe(
      "Blocked for safety: known malware \u00b7 npm install chalk@5.6.1",
    );
    expect(describeSecurityBlock("malicious-package", "npm i a", 3)).toBe(
      "Blocked for safety: known malware \u00b7 npm i a \u00d73",
    );
    expect(describeSecurityBlock("not-a-rule", "")).toBe("Blocked for safety: safety rule");
    expect(describeSecurityBlock("dns-exfil", "ping x")).toBe(
      "Blocked for safety: would leak data \u00b7 ping x",
    );
    expect(
      describeSecurityBlock(
        "installed-malware",
        "debug@4.4.2 (MAL-2025-46974) in package-lock.json",
      ),
    ).toBe(
      "Infected package in this project, replacing it \u00b7 debug@4.4.2 (MAL-2025-46974) in package-lock.json",
    );
    expect(describeSecurityBlock("brand-new-rule", "")).toBe("Blocked for safety: safety rule");
  });

  it("renders as a critter row", () => {
    const { container } = render(
      <SecurityNotice rule="malicious-package" target="npm install chalk@5.6.1" variantKey="7" />,
    );
    expect(screen.getByText(/Blocked for safety: known malware/)).toBeTruthy();
    expect(container.querySelector(".subagents-critter-stopped")).toBeTruthy();
  });
});
