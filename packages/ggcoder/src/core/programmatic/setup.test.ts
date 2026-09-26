import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assessProgrammaticSetup,
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
  type PersistProgrammaticProfileOptions,
} from "./profile.js";
import { PROGRAMMATIC_PROFILE_PATH } from "./inventory.js";
import { readProgrammaticChatReport } from "./lifecycle.js";
import { isProgrammaticChatResponse } from "@kenkaiiii/gg-core/programmatic-chat-contract";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-setup-drift-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  return root;
}
async function approve(root: string, options: PersistProgrammaticProfileOptions = {}) {
  const proposal = await buildProgrammaticProfileProposal(root);
  return persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
    expectedPriorProfileDigest: proposal.expectedPriorProfileDigest,
    ...options,
  });
}
async function bytes(root: string) {
  return fs.readFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "utf8");
}

it("inspects without writes and keeps current setup non-approvable across source changes", async () => {
  const root = await fixture();
  const proposal = await buildProgrammaticProfileProposal(root);
  expect(proposal.operation).toBe("initial");
  expect(proposal.expectedPriorProfileDigest).toBeNull();
  expect(await fs.readdir(root)).toEqual(["package.json"]);
  expect(await approve(root)).toMatchObject({ ok: true, changed: true });
  const saved = await bytes(root);
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(root, "source.ts"), `export const value = ${i};`);
    const current = await buildProgrammaticProfileProposal(root);
    expect(current.operation).toBe("current");
    expect(current.routes).toEqual([]);
    expect(current.profile).toEqual(proposal.profile);
    expect(await approve(root)).toMatchObject({ ok: true, changed: false });
    expect(await bytes(root)).toBe(saved);
  }
});

it("requires a matching prior-byte digest for refresh and preserves lifecycle bytes", async () => {
  const root = await fixture();
  await approve(root);
  const saved = await bytes(root);
  const statePath = path.join(root, ".gg/programmatic/state.json");
  await fs.writeFile(statePath, "independent lifecycle bytes");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
  const proposal = await buildProgrammaticProfileProposal(root);
  expect(proposal.operation).toBe("refresh");
  expect(proposal.drift?.files).toEqual([
    expect.objectContaining({ path: "package.json", kind: "modified" }),
  ]);
  expect(await bytes(root)).toBe(saved);
  await expect(
    persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile),
  ).rejects.toThrow(/changed since review/);
  expect(await bytes(root)).toBe(saved);
  expect(await approve(root)).toMatchObject({ ok: true, changed: true });
  expect(await fs.readFile(statePath, "utf8")).toBe("independent lifecycle bytes");
  expect((await assessProgrammaticSetup(root)).status).toBe("current");
});

it("requires explicit known-v1 upgrade without inventing historical file drift", async () => {
  const root = await fixture();
  await approve(root);
  const current = JSON.parse(await bytes(root));
  const legacy = JSON.stringify({
    version: 1,
    profile: current.profile,
    configurationFingerprint: current.configurationFingerprint,
  });
  await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), legacy);
  const proposal = await buildProgrammaticProfileProposal(root);
  expect(proposal).toMatchObject({ operation: "refresh", baselineUnavailable: true, drift: null });
  expect(proposal.configurationInputs.map((input) => input.path)).toEqual(["package.json"]);
  expect(await bytes(root)).toBe(legacy);
  expect(await approve(root)).toMatchObject({ ok: true, changed: true });
  expect(JSON.parse(await bytes(root)).version).toBe(2);
});

it.each(["{", '{"version":99}', '{"version":1,"profile":{}}'])(
  "fails closed on unsupported or malformed setup: %s",
  async (invalid) => {
    const root = await fixture();
    await approve(root);
    await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), invalid);
    expect((await assessProgrammaticSetup(root)).status).toBe("unreadable");
    await expect(buildProgrammaticProfileProposal(root)).rejects.toThrow(/unsupported/);
    expect(await bytes(root)).toBe(invalid);
  },
);

it("rejects inconsistent snapshot metadata and incomplete inventory without rewriting setup", async () => {
  const root = await fixture();
  await approve(root);
  const saved = await bytes(root);
  const corrupt = JSON.parse(saved);
  corrupt.configurationSnapshot.inputs = [];
  await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), JSON.stringify(corrupt));
  expect((await assessProgrammaticSetup(root)).status).toBe("unreadable");
  await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), saved);
  await fs.writeFile(path.join(root, "large.dll"), Buffer.alloc(16 * 1024 * 1024 + 1));
  const listed = await assessProgrammaticSetup(root);
  expect(listed.status).toBe("current");
  expect(listed.inventory?.inventory.entries).toContainEqual({ path: "large.dll", bytes: 16 * 1024 * 1024 + 1 });
  await fs.writeFile(path.join(root, "tsconfig.json"), Buffer.alloc(16 * 1024 * 1024 + 1));
  const assessment = await assessProgrammaticSetup(root);
  expect(assessment.status).toBe("unreadable");
  expect(assessment.diagnostic).toBe(
    "A project setup file is larger than 16 MB, so this project cannot be checked.",
  );
  expect(assessment.stored?.envelope.profile).toEqual(corrupt.profile);
  expect(await bytes(root)).toBe(saved);
});

it("explains project-size failures instead of blaming saved setup", async () => {
  const root = await fixture();
  for (let i = 0; i < 10_001; i += 1) await fs.writeFile(path.join(root, `f${i}`), "");
  const assessment = await assessProgrammaticSetup(root);
  expect(assessment.status).toBe("unreadable");
  expect(assessment.diagnostic).toMatch(/^This project is too large to check: it has more than 10,000 files\./);
  expect(assessment.diagnostic).not.toContain(root);
  expect(assessment.diagnostic).not.toContain("Stored setup");
  expect(assessment.failure).toBe("inventory");
  expect(assessment.stored).toBeNull();
  const report = await readProgrammaticChatReport(root);
  expect(report.configuration).toMatchObject({ status: "unreadable", failure: "inventory" });
  expect(report.reason).toBe("This project could not be checked. See Setup error details.");
  expect(report.reason).not.toContain("Saved settings cannot be read");
  expect(report.reason).not.toContain(root);
  expect(isProgrammaticChatResponse({ version: 1, action: "report", ok: true, report })).toBe(true);
});

it("keeps the repair message for unreadable saved setup", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), "{");
  const assessment = await assessProgrammaticSetup(root);
  expect(assessment.diagnostic).toMatch(/Repair is required before approval or scanning\.$/);
  expect(assessment.failure).toBe("stored");
  const report = await readProgrammaticChatReport(root);
  expect(report.configuration?.failure).toBe("stored");
  expect(report.reason).toBe("Saved settings cannot be read. Any results shown are from an earlier check.");
});

it.each(["writeFile", "rename"] as const)(
  "preserves previous setup on %s failure and permits retry",
  async (operation) => {
    const root = await fixture();
    await approve(root);
    const saved = await bytes(root);
    await fs.writeFile(path.join(root, "package.json"), "\n{}\n");
    await expect(
      approve(root, {
        operations: {
          [operation]: async () => {
            throw new Error("injected failure");
          },
        },
      }),
    ).rejects.toThrow("injected failure");
    expect(await bytes(root)).toBe(saved);
    expect(await fs.readdir(path.join(root, ".gg/programmatic"))).toEqual(["profile.json"]);
    expect(await approve(root)).toMatchObject({ ok: true, changed: true });
  },
);

it.each(["writeFile", "rename"] as const)("preserves the original %s error when cleanup also fails", async (operation) => {
  const root = await fixture();
  await approve(root);
  const previous = await bytes(root);
  await fs.writeFile(path.join(root, "package.json"), "\n{}\n");
  const original = new Error("original pre-commit failure");
  await expect(approve(root, { operations: {
    [operation]: async () => { throw original; },
    rm: async (file, options) => {
      await fs.rm(file, options);
      throw new Error("cleanup failure");
    },
  } })).rejects.toBe(original);
  expect(await bytes(root)).toBe(previous);
  expect((await buildProgrammaticProfileProposal(root)).operation).toBe("refresh");
});

it.each([
  ["initial", false], ["initial", true], ["refresh", false], ["refresh", true],
] as const)("reports committed %s cleanup failure (notification failure: %s)", async (operation, notificationFails) => {
  const root = await fixture();
  if (operation === "refresh") await approve(root);
  const previous = operation === "refresh" ? await bytes(root) : null;
  await fs.mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  const statePath = path.join(root, ".gg/programmatic/state.json");
  await fs.writeFile(statePath, "independent lifecycle bytes");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}\n');
  const proposal = await buildProgrammaticProfileProposal(root);
  expect(proposal.operation).toBe(operation);
  let cleanups = 0;
  let notifications = 0;
  const result = await approve(root, {
    operations: { rm: async () => {
      cleanups++;
      throw new Error("cleanup failure");
    } },
    onCommitted: () => {
      notifications++;
      if (notificationFails) throw new Error("notification failure");
    },
  });
  expect(result).toMatchObject({ ok: false, changed: true, error: "post-commit-failed",
    detail: expect.stringMatching(/Read back setup before retrying/) });
  expect(cleanups).toBe(1);
  expect(notifications).toBe(1);
  const saved = await bytes(root);
  expect(saved).not.toBe(previous);
  expect(JSON.parse(saved)).toEqual({ version: 2, profile: proposal.profile,
    configurationFingerprint: proposal.configurationFingerprint,
    configurationSnapshot: proposal.configurationSnapshot });
  expect(await fs.readFile(statePath, "utf8")).toBe("independent lifecycle bytes");
  expect((await buildProgrammaticProfileProposal(root)).operation).toBe("current");
});

it("revalidates configuration after the pre-mutation callback", async () => {
  const root = await fixture();
  await approve(root);
  const saved = await bytes(root);
  await fs.writeFile(path.join(root, "package.json"), "\n{}\n");
  expect(
    await approve(root, {
      onPreMutation: () => fs.writeFile(path.join(root, "package.json"), "\n\n{}\n"),
    }),
  ).toMatchObject({ ok: false, changed: false, error: "stale-proposal" });
  expect(await bytes(root)).toBe(saved);
});

it("rejects a competing prior-byte write after review and after the pre-mutation callback", async () => {
  const root = await fixture();
  await approve(root);
  await fs.writeFile(path.join(root, "package.json"), "\n{}\n");
  const proposal = await buildProgrammaticProfileProposal(root);
  const saved = await bytes(root);
  await fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), saved + "\n");
  await expect(
    persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
      expectedPriorProfileDigest: proposal.expectedPriorProfileDigest,
    }),
  ).rejects.toThrow(/changed since review/);
  await expect(
    approve(root, {
      onPreMutation: () => fs.writeFile(path.join(root, PROGRAMMATIC_PROFILE_PATH), saved + "\n\n"),
    }),
  ).rejects.toThrow(/changed before commit/);
  expect(await bytes(root)).toBe(saved + "\n\n");
});

it("accepts identical competing approvals once and reports post-commit notification uncertainty", async () => {
  const root = await fixture();
  const proposal = await buildProgrammaticProfileProposal(root);
  const results = await Promise.all(
    [0, 1].map(() =>
      persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, {
        expectedPriorProfileDigest: null,
      }),
    ),
  );
  expect(results.filter((result) => result.changed)).toHaveLength(1);
  expect(results.every((result) => result.ok)).toBe(true);
  await fs.writeFile(path.join(root, "package.json"), "\n{}\n");
  expect(
    await approve(root, {
      onCommitted: () => {
        throw new Error("notification failure");
      },
    }),
  ).toMatchObject({ ok: false, changed: true, error: "post-commit-failed" });
  expect((await assessProgrammaticSetup(root)).status).toBe("current");
  expect(await approve(root)).toMatchObject({ ok: true, changed: false });
});

it("rejects a linked profile parent introduced during a read", async () => {
  const root = await fixture();
  const outside = await fixture();
  await approve(root);
  const saved = await bytes(root);
  await fs.writeFile(path.join(outside, "profile.json"), saved);
  const assessment = await assessProgrammaticSetup(root, { operations: {
    readFile: async (file) => {
      const contents = await fs.readFile(file);
      await fs.rename(path.join(root, ".gg/programmatic"), path.join(root, ".gg/retained"));
      await fs.symlink(outside, path.join(root, ".gg/programmatic"), "junction");
      return contents;
    },
  } });
  expect(assessment.status).toBe("unreadable");
  expect(assessment.stored).toBeNull();
  expect(await fs.readFile(path.join(outside, "profile.json"), "utf8")).toBe(saved);
});

it("rethrows cancellation instead of reporting the project as unreadable", async () => {
  const root = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(assessProgrammaticSetup(root, { signal: controller.signal })).rejects.toThrow();
  await expect(
    assessProgrammaticSetup(root, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
