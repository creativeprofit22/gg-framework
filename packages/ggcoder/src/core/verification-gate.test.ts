import { describe, expect, it } from "vitest";
import {
  VerificationGate,
  isCodeFilePath,
  isVerificationCommand,
  MAX_VERIFICATION_INJECTIONS,
} from "./verification-gate.js";

describe("isVerificationCommand", () => {
  const yes = [
    ["npm test", "npm test"],
    ["pnpm test:unit", "script name with test: prefix"],
    ["yarn run build", "yarn run build"],
    ["npx vitest run src", "npx vitest"],
    ["vitest run", "bare vitest"],
    ["jest --coverage", "bare jest"],
    ["tsc --noEmit", "bare tsc"],
    ["eslint src/", "bare eslint"],
    ["go test ./...", "go test"],
    ["cargo test", "cargo test"],
    ["cargo clippy", "cargo clippy"],
    ["make check", "make check"],
    ["python -m pytest -x", "python -m pytest"],
    ["pytest tests/", "bare pytest"],
    ["uv run pytest", "uv run pytest"],
    ["timeout 30s npm test", "timeout wrapper with duration"],
    ["CI=1 npm test", "env-var wrapper"],
    ["ruff check src", "ruff check"],
    ["biome check .", "biome check"],
    ["gradle test", "gradle test"],
    ["dotnet test", "dotnet test"],
    ["deno task test", "deno task test"],
    // Compound / chained shells: the classifier must look past the first word.
    ["cd packages/app && npm test", "cd into a package then test"],
    ["cd /tmp/proj && pnpm --filter web test", "cd then filtered workspace test"],
    ["npm run typecheck && npm run lint && npm run test", "chained checks"],
    ["npm run build; npm test", "semicolon-separated"],
    ["npm run test 2>&1 | tee /tmp/out.log", "piped into tee"],
    ["npm test 2>&1 | tail -50", "piped into tail"],
    ["npm run lint || npm test", "or-chained"],
    ["(cd api && cargo test)", "subshell"],
    ["git add -A && npm test", "non-verification first, verification second"],
    ['sh -c "npm test"', "sh -c wrapper"],
    ['bash -c "cd pkg && npm test"', "bash -c wrapping a chain"],
    ["sh -c 'pytest tests/'", "sh -c with single quotes"],
    ["cd pkg\nnpm test", "newline-separated"],
  ];
  const no = [
    ["git commit -m fix test", "commit message mentioning test"],
    ["grep test file.ts", "grep for the word test"],
    ["cat test-output.log", "cat a log"],
    ["./run_tests.sh", "direct script"],
    ["bash scripts/test.sh", "bash-invoked script"],
    ["npm install", "package install"],
    ["npm run dev", "dev server"],
    ["go run main.go", "go run"],
    ["python train.py", "python script"],
    ["echo running tests soon", "echo mentioning tests"],
    // Compound negatives: splitting must not invent verification.
    ["cd packages/app && npm install", "cd then install"],
    ["git add -A && git commit -m 'add test'", "chained git with test in the message"],
    ["cd src && ./run_tests.sh", "cd then direct script"],
    ['echo "npm test" > notes.txt', "verification text inside a quoted argument"],
    ['sh -c "npm run dev"', "sh -c wrapping a dev server"],
    ["bash scripts/test.sh", "bash running a script file, not -c"],
    ["cat out.log | grep test", "piped grep"],
  ];

  it.each(yes)("classifies %s as verification (%s)", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });
  it.each(no)("classifies %s as NOT verification (%s)", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });
});

describe("isCodeFilePath", () => {
  it("accepts source files", () => {
    expect(isCodeFilePath("src/a.ts")).toBe(true);
    expect(isCodeFilePath("src/a.test.tsx")).toBe(true);
    expect(isCodeFilePath("lib/x.py")).toBe(true);
    expect(isCodeFilePath("src/main.rs")).toBe(true);
    expect(isCodeFilePath("cmd/tool.go")).toBe(true);
  });
  it("rejects non-code files", () => {
    expect(isCodeFilePath("README.md")).toBe(false);
    expect(isCodeFilePath("package.json")).toBe(false);
    expect(isCodeFilePath("logo.svg")).toBe(false);
    expect(isCodeFilePath("notes.txt")).toBe(false);
  });
});

describe("VerificationGate", () => {
  it("is silent with no mutations", () => {
    const gate = new VerificationGate();
    gate.recordVerification();
    expect(gate.isOwed()).toBe(false);
    expect(gate.followUp()).toBeNull();
  });

  it("is owed after a mutation until a verification follows", () => {
    const gate = new VerificationGate();
    gate.recordVerification();
    gate.recordMutation("a.ts");
    expect(gate.isOwed()).toBe(true);
    const followUp = gate.followUp()!;
    expect(followUp).toHaveLength(1);
    expect(String(followUp[0]!.content)).toContain("a.ts");
    gate.recordVerification();
    expect(gate.isOwed()).toBe(false);
    expect(gate.followUp()).toBeNull();
  });

  it("demands once, then goes silent on every later stop while still owed", () => {
    const gate = new VerificationGate();
    gate.recordMutation("a.ts");

    const demand = gate.followUp()!;
    expect(String(demand[0]!.content)).toContain("Run the project's verification");

    // Model stopped again without verifying: still owed, but no second turn is
    // spent on it — each extra injection costs the user another final answer.
    expect(gate.isOwed()).toBe(true);
    expect(gate.followUp()).toBeNull();
    expect(gate.followUp()).toBeNull();
    expect(MAX_VERIFICATION_INJECTIONS).toBe(1);
  });

  it("carries the unverified-disclosure fallback in its single demand", () => {
    const gate = new VerificationGate();
    gate.recordMutation("a.ts");
    // The dropped escalation turn existed only to ask for this; the demand now
    // asks for it up front, so the honesty requirement survives without a turn.
    expect(String(gate.followUp()![0]!.content)).toContain("unverified");
  });

  it("spends no injection when nothing is owed, so a later mutation still gets its demand", () => {
    const gate = new VerificationGate();
    expect(gate.followUp()).toBeNull();
    gate.recordMutation("a.ts");
    expect(String(gate.followUp()![0]!.content)).toContain("Run the project's verification");
  });

  it("a later mutation re-arms an already-satisfied gate after a fresh budget reset", () => {
    const gate = new VerificationGate();
    gate.recordMutation("a.ts");
    gate.followUp();
    gate.recordVerification();
    expect(gate.followUp()).toBeNull();
    gate.reset();
    expect(gate.isOwed()).toBe(false);
  });
});
