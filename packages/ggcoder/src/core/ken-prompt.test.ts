import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { buildKenSystemPrompt, buildKenAutopilotSystemPrompt } from "./ken-prompt.js";
import { INJECTED_PROMPT_LABEL } from "./ken-context.js";

// No CLAUDE.md/AGENTS.md up the tree from tmpdir, so the appended project-
// context section is empty and these assertions stay focused on the persona.
const TEST_CWD = os.tmpdir();

describe("buildKenAutopilotSystemPrompt — verdict contract", () => {
  let prompt: string;
  beforeAll(async () => {
    prompt = await buildKenAutopilotSystemPrompt(TEST_CWD);
  });

  it("teaches all four verdict keywords", () => {
    for (const keyword of ["PROMPT", "ALL_CLEAR", "IGNORE", "HUMAN"]) {
      expect(prompt).toContain(keyword);
    }
  });

  it("routes only real user-level questions/options to HUMAN", () => {
    // Leak regression: without this rule, GG Coder ending with "want me to…?"
    // or an A/B/C menu reads as "unfinished" and Ken answers for the user.
    // But the inverse matters too: permission to continue obvious safe work is
    // NOT a user decision and should be a PROMPT, not a blocker. This is a
    // principle, not a list of special-case examples.
    expect(prompt).toContain("asking the ");
    expect(prompt).toContain("presenting options");
    expect(prompt).toContain("HUMAN only when answering it requires");
    expect(prompt).toContain("user-level decisions");
    expect(prompt).toContain("mechanically implied by the user's original ask");
    expect(prompt).toContain("safe to do without new information");
    expect(prompt).toContain("Use PROMPT with the concrete next step");
  });

  it("trusts only harness-classified passed verification evidence", () => {
    expect(prompt).toContain("trust only PASSED rows");
    expect(prompt).toContain("FAILED or REJECTED rows");
    expect(prompt).toContain("model-authored claims are not proof");
  });

  it("makes Ken the plan reviewer (no automatic HUMAN on plan submissions)", () => {
    // In autopilot, a submitted plan is reviewed by Ken himself — approve,
    // revise, or (rarely) hand a genuine product decision to the user.
    expect(prompt).toContain("Plans are YOURS to review");
    expect(prompt).toContain("'Plan under review' section");
    expect(prompt).toContain("implementation starts immediately");
    expect(prompt).toContain("Default to approving a sound plan");
    expect(prompt).toContain("Never IGNORE a plan");
    // The old auto-HUMAN clause must be gone.
    expect(prompt).not.toContain("submitting a plan for approval");
  });

  it("gives plan review a design bar: steps, boundaries, order, uncovered paths", () => {
    // Post-turn review deliberately cannot ask "is this shape right?" — it
    // judges a finished diff against the ask, and relitigating structure every
    // turn is how the autopilot loop stops terminating. Plan review is the one
    // branch where the question is both answerable and cheap, because no code
    // exists yet. Each of the four tests below is load-bearing; a plan can be
    // internally sound and still fail any one of them.
    expect(prompt).toContain("judge the shape");
    expect(prompt).toContain("does every step earn its existence");
    expect(prompt).toContain("boundary between steps sit where the work actually splits");
    expect(prompt).toContain("is the order forced by real dependencies");
    expect(prompt).toContain("what happens on the paths the plan never names");

    // A structural flaw has to be actionable and separable from taste, or the
    // bar collapses back into the nitpicking the contract already forbids.
    expect(prompt).toContain("is a structural flaw");
    expect(prompt).toContain("PROMPT it, naming the step");
    expect(prompt).toContain("taste nitpicks are still not blockers");
    expect(prompt).toContain("is taste unless you can name what it breaks");
  });

  it("keeps the design bar out of post-turn verdicts", async () => {
    // Scope guard: the bar lives in the plan-review bullet only. If it ever
    // leaks into the turn-review rules, Ken starts re-opening architecture on
    // finished work and ALL_CLEAR stops being reachable.
    const planBullet = prompt.slice(
      prompt.indexOf("- Plans are YOURS to review"),
      prompt.indexOf("- Transcript lines labeled"),
    );
    expect(planBullet).toContain("judge the shape");
    expect(prompt.match(/judge the shape/g) ?? []).toHaveLength(1);
    expect(prompt.match(/earn its existence/g) ?? []).toHaveLength(1);

    // The turn-review default survives untouched.
    const chat = await buildKenSystemPrompt(TEST_CWD);
    expect(chat).not.toContain("ALL_CLEAR");
  });

  it("tells Ken injected transcript lines are his own, not user asks", () => {
    expect(prompt).toContain("Ken autopilot (injected)");
    expect(prompt).toContain("Judge only against the original user request");
  });

  it("anchors ALL_CLEAR judgment to the pinned Original user request section", () => {
    expect(prompt).toContain("Original ");
    expect(prompt).toContain("user request' section");
    expect(prompt).toContain("never a later injected prompt");
  });

  it("keeps the injected label byte-identical to the digest renderer's", () => {
    // The system prompt names the label in prose; the digest emits it. If the
    // label constant drifts, the prompt's rule points at nothing.
    expect(INJECTED_PROMPT_LABEL).toContain("Ken autopilot (injected)");
    expect(prompt).toContain("Ken autopilot (injected)");
  });

  it("kills the standalone why — reasons live only inside a PROMPT body", () => {
    // Drift regression: chat Ken is trained to drop a one-line reason before a
    // prompt; autopilot Ken carried that habit over and front-loaded reasoning
    // prose before the keyword, which parsed as a HUMAN stop and stalled the
    // cycle. The contract must name the habit and give the why exactly one
    // legal home: inside the PROMPT body, only when GG Coder needs it.
    expect(prompt).toContain("NOT ");
    expect(prompt).toContain("no audience for a why");
    expect(prompt).toContain("Never justify your verdict");
    expect(prompt).toContain("INSIDE a PROMPT body");
    expect(prompt).toContain("when GG Coder itself needs it");
  });

  it("shows a contrastive WRONG/RIGHT example of the drift", () => {
    // Models obey a wrong→right pair better than prohibitions alone.
    expect(prompt).toContain("WRONG — reasoning before the keyword");
    expect(prompt).toContain("RIGHT — keyword first");
  });

  it("forbids commentary before or after the keyword line", () => {
    // Leak regression: Ken once prefaced ALL_CLEAR with a recap/opinion ("The
    // label is now a plain non-clickable span... Typecheck passed.\nALL_CLEAR"),
    // which the parser couldn't read as a bare verdict and surfaced as a raw
    // HUMAN bubble. The prompt must explicitly ban prose around the keyword.
    expect(prompt).toContain("nothing before it");
    expect(prompt).toContain("never add commentary");
    expect(prompt).toContain("no recap of what you found");
  });
});

describe("buildKenSystemPrompt — chat mode unaffected", () => {
  it("keeps the chat output contract (prompt fence) and no verdict keywords", async () => {
    const prompt = await buildKenSystemPrompt(TEST_CWD);
    expect(prompt).toContain("Send to GG Coder");
    // The verdict contract is autopilot-only.
    expect(prompt).not.toContain("ALL_CLEAR");
  });
});

describe("UI guidance alignment", () => {
  it("reviews UI through the matching skill and evidence without wholesale copying", async () => {
    for (const prompt of [
      await buildKenSystemPrompt(TEST_CWD),
      await buildKenAutopilotSystemPrompt(TEST_CWD),
    ]) {
      expect(prompt).toContain("UI: evidence over imitation");
      expect(prompt).toContain("use an invoked matching UI skill as specialized guidance");
      expect(prompt).toContain("explicitly shows that the skill was available and applicable");
      expect(prompt).toContain("existing components and tokens");
      expect(prompt).toContain("rendered desktop and mobile output");
      expect(prompt).toContain("References are evidence, not templates to clone");
      expect(prompt).not.toContain("copy proven winners");
      expect(prompt).not.toContain("pull the actual markup and computed styles");
    }
  });
});

describe("GG Coder capabilities — both modes know what the executor can do", () => {
  it("teaches Ken GG Coder's real toolset in chat AND autopilot", async () => {
    // Ken directs GG Coder, so both prompts must ground his instructions in the
    // executor's actual capabilities (plan mode, subagents, bash, screenshots),
    // not leave him guessing from the transcript.
    for (const prompt of [
      await buildKenSystemPrompt(TEST_CWD),
      await buildKenAutopilotSystemPrompt(TEST_CWD),
    ]) {
      expect(prompt).toContain("What GG Coder can do");
      expect(prompt).toContain("enter_plan");
      expect(prompt).toContain("subagents");
      expect(prompt).toContain("bash");
      expect(prompt).toContain("screenshot");
    }
  });

  it("draws the boundary: Ken's own tools check, GG Coder's tools build", async () => {
    // Ken should verify facts with his own read-only tools before delegating,
    // not send GG Coder to find out something he could confirm faster himself.
    for (const prompt of [
      await buildKenSystemPrompt(TEST_CWD),
      await buildKenAutopilotSystemPrompt(TEST_CWD),
    ]) {
      expect(prompt).toContain("Check with your own eyes first");
      expect(prompt).toContain("then delegate the real work");
    }
  });
});

describe("buildKenSystemPrompt / buildKenAutopilotSystemPrompt — project context", () => {
  it("folds project context into the cached system prompt, not the per-turn digest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ken-prompt-test-"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Build a todo app.");
    try {
      const chat = await buildKenSystemPrompt(dir);
      const autopilot = await buildKenAutopilotSystemPrompt(dir);
      expect(chat).toContain("Build a todo app.");
      expect(autopilot).toContain("Build a todo app.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
