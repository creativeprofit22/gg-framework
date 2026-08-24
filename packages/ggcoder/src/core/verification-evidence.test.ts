import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  classifyVerificationCommand,
  collectVerificationEvidence,
  evaluateRoadmapVerificationEvidence,
  partitionVerificationMessagesForRevision,
} from "./verification-evidence.js";

describe("classifyVerificationCommand", () => {
  it.each([
    "tsc --noEmit",
    "pnpm exec tsc --noEmit --pretty false",
    "pnpm --filter @kenkaiiii/gg-ai check",
    "pnpm -w typecheck",
    "vitest run src/foo.test.ts",
    "pnpm test -- --runInBand",
    "cargo fmt --check && cargo clippy",
    "ruff format --check .",
  ])("accepts bounded check: %s", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: true,
      candidate: true,
    });
  });

  it.each([
    ["tsc --init", "mutating"],
    ["tsc --build", "mutating"],
    ["tsc --noEmit --incremental", "mutating"],
    ["tsc --noEmit --tsBuildInfoFile cache.tsbuildinfo", "mutating"],
    ["prettier --write src", "mutating"],
    ["pnpm build", "artifact-producing"],
    ["tsc --watch --noEmit", "long-running"],
    ["vitest --watch", "long-running"],
    ["pnpm dev", "long-running"],
    ["tsc", "--noEmit"],
    ["tsc --noEmit --noCheck", "does not prove"],
    ["tsc --noEmit --listFilesOnly", "does not prove"],
    ["tsc --showConfig", "does not prove"],
    ["tsc --help", "does not prove"],
    ["tsc --version", "does not prove"],
    ["tsc --noEmit --generateTrace trace", "does not prove"],
    ["tsc --noEmit --generateCpuProfile cpu.cpuprofile", "does not prove"],
    ["tsc --noEmit > result.txt", "unsafe shell"],
    ["tsc --noEmit | cat", "control operator"],
    ["tsc --noEmit || echo ignored", "control operator"],
    ["tsc --noEmit; echo ignored", "control operator"],
    ["tsc --noEmit && npm run clean", "mutating"],
  ])("rejects non-evidence command: %s", (command, reason) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: false,
      candidate: true,
      reason: expect.stringContaining(reason),
    });
  });

  it("rejects unknown commands without mislabeling ordinary shell work as verification", () => {
    expect(classifyVerificationCommand("git status --short")).toMatchObject({
      accepted: false,
      candidate: false,
    });
  });
});

function bashExchange(
  id: string,
  command: string,
  result: string,
  args: Record<string, unknown> = {},
): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "bash", args: { command, ...args } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: result }],
    },
  ];
}

function roadmapExchange(id: string, revision: number): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id,
          name: "roadmap_status",
          args: { expected_revision: revision - 1 },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: id,
          content: JSON.stringify({ result: "committed", revision }),
        },
      ],
    },
  ];
}

describe("collectVerificationEvidence", () => {
  it("records only successful bounded checks as passed evidence", () => {
    const messages: Message[] = [
      ...bashExchange("pass", "tsc --noEmit", "Exit code: 0\n"),
      ...bashExchange("fail", "vitest run src/foo.test.ts", "Exit code: 1\n1 test failed"),
      ...bashExchange("watch", "tsc --watch --noEmit", "Exit code: 0\nWatching"),
      ...bashExchange("ordinary", "git status --short", "Exit code: 0\n"),
      ...bashExchange("background", "vitest run", "Background process started.", {
        run_in_background: true,
      }),
    ];

    expect(collectVerificationEvidence(messages)).toEqual([
      {
        command: "tsc --noEmit",
        status: "passed",
        reason: "bounded TypeScript no-emit check",
      },
      {
        command: "vitest run src/foo.test.ts",
        status: "failed",
        reason: "bounded check did not exit successfully",
      },
      {
        command: "tsc --watch --noEmit",
        status: "rejected",
        reason: "long-running watch/debug mode",
      },
      {
        command: "vitest run",
        status: "rejected",
        reason: "background or persistent commands are not bounded evidence",
      },
    ]);
  });
});

describe("evaluateRoadmapVerificationEvidence", () => {
  const evaluate = (
    messages: Message[],
    evidence: string[],
    doneWhen = ["criterion one"],
    expectedRevision: number | undefined = 15,
  ) => {
    const partition =
      expectedRevision === undefined
        ? { currentMessages: messages, staleMessages: [] }
        : partitionVerificationMessagesForRevision(messages, expectedRevision);
    return evaluateRoadmapVerificationEvidence({
      doneWhen,
      evidence,
      expectedRevision,
      ...partition,
    });
  };

  it("rejects unsafe shell wrappers even when the outer command exits zero", () => {
    const command = "vitest run smoke.test.ts || echo PASS";
    expect(evaluate(bashExchange("unsafe", command, "Exit code: 0\nPASS"), [command])).toEqual({
      ready: false,
      unmetEvidenceCodes: ["rejected-evidence", "missing-approved-evidence"],
    });
  });

  it("does not let an unrelated approved command mask the cited command's failure", () => {
    const required = "vitest run required.test.ts";
    const unrelated = "tsc --noEmit";
    expect(
      evaluate(
        [
          ...bashExchange("required", required, "Exit code: 1\n1 test failed"),
          ...bashExchange("unrelated", unrelated, "Exit code: 0"),
        ],
        [`${required}; unrelated approval: ${unrelated}`],
      ),
    ).toEqual({
      ready: false,
      unmetEvidenceCodes: ["unmatched-evidence", "missing-approved-evidence"],
    });
  });

  it("uses the latest execution when a previously passing command later fails", () => {
    const command = "vitest run current-phase.test.ts";
    expect(
      evaluate(
        [
          ...bashExchange("passing", command, "Exit code: 0"),
          ...bashExchange("failing", command, "Exit code: 1\n1 test failed"),
        ],
        [command],
      ),
    ).toEqual({
      ready: false,
      unmetEvidenceCodes: ["failed-evidence", "missing-approved-evidence"],
    });
  });

  it("rejects an unclassified row-700-style generic smoke command", () => {
    const command = "node scripts/roadmap-smoke.mjs";
    expect(
      evaluate(bashExchange("smoke", command, "Exit code: 0\nPASS criteria 1-5"), [command]),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: ["unclassified-evidence", "missing-approved-evidence"],
    });
  });

  it("rejects approved evidence from before the current revision", () => {
    const command = "vitest run current-phase.test.ts";
    const messages = [
      ...bashExchange("old", command, "Exit code: 0"),
      ...roadmapExchange("status", 15),
    ];
    expect(evaluate(messages, [command])).toMatchObject({
      ready: false,
      unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
    });
  });

  it("rejects duplicate command evidence and criterion count mismatches", () => {
    const command = "vitest run duplicate.test.ts";
    expect(
      evaluate(
        bashExchange("duplicate", command, "Exit code: 0"),
        [command, command],
        ["criterion one", "criterion two"],
      ),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: ["duplicate-evidence", "missing-approved-evidence"],
    });
    expect(
      evaluate(bashExchange("mismatch", command, "Exit code: 0"), [command], ["one", "two"]),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: expect.arrayContaining(["criterion-evidence-mismatch"]),
    });
  });

  it("accepts one distinct current approved command per criterion", () => {
    const first = "vitest run first.test.ts";
    const second = "tsc --noEmit";
    expect(
      evaluate(
        [
          ...bashExchange("first", first, "Exit code: 0"),
          ...bashExchange("second", second, "Exit code: 0"),
        ],
        [`criterion one — ${first}`, `criterion two — ${second}`],
        ["criterion one", "criterion two"],
      ),
    ).toEqual({ ready: true, unmetEvidenceCodes: [] });
  });
});
