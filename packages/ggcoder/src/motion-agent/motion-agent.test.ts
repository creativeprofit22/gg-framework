import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentSessionOptions } from "../core/agent-session.js";
import { buildSubAgentSystemPrompt, SUBAGENT_RETURN_CONTRACT } from "../system-prompt.js";
import { createSkillTool } from "../tools/skill.js";
import { CONTEXT_LIMITS, resolveContextLimits } from "../core/context-limits.js";
import {
  BUNDLED_SKILLS_DIRS,
  discoverSkills,
  findMotionBundle,
  loadMotionSkills,
} from "../core/skills.js";
import {
  buildMotionAgentPrompt,
  createMotionAgentSession,
  MOTION_SKILL_CATALOG_BYTES,
  motionCliCommand,
  motionMusicDir,
  motionSessionsDir,
  motionSfxDir,
} from "./motion-agent.js";

const execFileAsync = promisify(execFile);

function optionsOf(agent: unknown): AgentSessionOptions {
  return (agent as { opts: AgentSessionOptions }).opts;
}

/** GG's own Motion skills; the rest of the bundle is the pinned HyperFrames set. */
const GG_MOTION_SKILLS = [
  "apple-motion",
  "brand-kit",
  "component-import",
  "launch-video",
  "long-form",
  "motion-3d",
  "motion",
  "motion-direction",
  "reference-style",
  "repo-video",
  "sound-design",
  "source-ingest",
  "style-library",
  "type-system",
  "video-qa",
  "visual-toolkit",
];

describe("Motion agent", () => {
  it("keeps library selection subordinate to the approved design across prompt and skills", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");

    const prompt = buildMotionAgentPrompt(bundle);
    const library = await fs.readFile(
      path.join(bundle.skillsDir, "style-library", "SKILL.md"),
      "utf8",
    );
    const qa = await fs.readFile(path.join(bundle.skillsDir, "video-qa", "SKILL.md"), "utf8");

    expect(prompt).toContain("A later-loaded skill never overrides an approved decision");
    expect(prompt).toContain(
      "If two explicit user requirements remain incompatible, ask one focused question",
    );
    expect(prompt).toContain("Preserve required brand fonts");
    expect(prompt).not.toContain("pick one look from the style library (offer 2–3");
    expect(prompt).toContain("Workers may not revise the contract or choose another look");
    expect(library).toContain("do not force a preset");
    expect(library).toContain("**Reuse:**");
    expect(library).toContain("**Adapt:**");
    expect(library).toContain("**Derive:**");
    expect(library).toContain("a search bar can inform a filter panel");
    expect(library).toContain("map installed pieces to those tokens");
    expect(qa).toContain("both the actual scene source and rendered frames");
    expect(qa).toContain("Missing evidence is unverified, not PASS");
  });

  it("stores sessions in their own namespace beside coder and chat", () => {
    const coderSessions = path.resolve("/tmp", "gg", "sessions");
    expect(motionSessionsDir(coderSessions)).toBe(path.resolve("/tmp", "gg", "motion-sessions"));
  });

  it("ships a valid bundle whose skills include GG's and the HyperFrames router", async () => {
    const bundle = await findMotionBundle();
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    const names = (await loadMotionSkills(bundle)).map((skill) => skill.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    for (const name of [...GG_MOTION_SKILLS, "hyperframes", "product-launch-video"]) {
      expect(names).toContain(name);
    }
  });

  it("bundles brag with its licensed music, cue maps and credits", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");

    const names = (await loadMotionSkills(bundle)).map((skill) => skill.name);
    const music = await fs.readdir(path.join(bundle.skillsDir, "brag", "assets", "music"));
    const cues = await fs.readdir(path.join(bundle.skillsDir, "brag", "assets", "music", "cues"));
    const credits = await fs.readFile(path.join(bundle.root, "THIRD-PARTY.md"), "utf8");

    expect(names).toEqual(expect.arrayContaining(["brag", "brag-slim"]));
    const tracks = music.filter((file) => file.endsWith(".mp3"));
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(cues).toContain(track.replace(/\.mp3$/, ".music-cues.json"));
    }
    await expect(fs.access(path.join(bundle.root, "BRAG-LICENSE"))).resolves.toBeUndefined();
    expect(credits).toContain("CC BY 4.0");
    expect(credits).toContain("Content ID");
  });

  it("lists every Motion skill in the skill tool without hitting the catalog budget", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const skills = await loadMotionSkills(bundle);

    const { description } = createSkillTool(
      skills,
      resolveContextLimits({ skillCatalogBytes: MOTION_SKILL_CATALOG_BYTES }),
    );

    for (const skill of skills) expect(description).toContain(skill.name);
    expect(description).not.toMatch(/omitted/i);
    // Keep real headroom so the next skill doesn't silently fall off the list.
    expect(Buffer.byteLength(description)).toBeLessThan(MOTION_SKILL_CATALOG_BYTES * 0.75);
  });

  it("raises the skill budget for Motion only, leaving the global default alone", () => {
    expect(MOTION_SKILL_CATALOG_BYTES).toBeGreaterThan(CONTEXT_LIMITS.skillCatalogBytes);
    expect(CONTEXT_LIMITS.skillCatalogBytes).toBe(16 * 1024);
  });

  it("keeps the Motion bundle outside every default bundled-skills location", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    for (const dir of BUNDLED_SKILLS_DIRS) {
      const rel = path.relative(dir, bundle.skillsDir);
      const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      expect(inside).toBe(false);
    }
  });

  it("keeps every Motion-bundled skill out of normal skill discovery", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const motionSkills = (await loadMotionSkills(bundle)).map((skill) => skill.name);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-skills-"));
    try {
      const discovered = await discoverSkills({
        globalSkillsDir: path.join(tmp, "global"),
        projectDir: tmp,
      });
      const names = new Set(discovered.map((skill) => skill.name));

      // Every bundled Motion skill (GG's, HyperFrames', brag) stays Motion-only.
      expect(motionSkills).toEqual(expect.arrayContaining(["brag", "brag-slim", "hyperframes"]));
      for (const name of motionSkills) {
        expect(names.has(name)).toBe(false);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("fills the prompt with this install's launcher and never leaves placeholders", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");

    const prompt = buildMotionAgentPrompt(bundle, "/opt/node/bin/node");
    const hf = motionCliCommand(bundle, "/opt/node/bin/node");
    const binDir = path.join(bundle.root, "bin");
    expect(prompt).toContain(hf);
    expect(prompt).toContain("/opt/node/bin/node");
    expect(prompt).toContain(binDir);
    for (const helper of [
      "pdf-extract.mjs",
      "score-synth.mjs",
      "contact-sheet.mjs",
      "reveal.mjs",
      "fonts.mjs",
      "three.mjs",
      "library.mjs",
    ]) {
      expect(prompt).toContain(helper);
      await expect(fs.access(path.join(binDir, helper))).resolves.toBeUndefined();
    }
    // The hf command is written out where it is defined, not per use.
    expect(prompt.split(hf).length - 1).toBe(1);
    // Helpers run on the bundled Node, defined once as <node>. The quoting is
    // platform-specific (single on POSIX, double on Windows), so match either.
    expect(prompt).toMatch(/\*\*<node>\*\* = `(['"])\/opt\/node\/bin\/node\1`/);
    expect(prompt).toContain(`HyperFrames ${bundle.version}`);
    expect(prompt).toContain("Load the `motion` skill first");
    expect(prompt).toContain("Ask the user at these checkpoints (ask_user, every time)");
    expect(prompt).toContain("**What to make**");
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("has GG's skills run helper scripts with <node>, never a bare node", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const ggSkills = (await loadMotionSkills(bundle)).filter((skill) =>
      GG_MOTION_SKILLS.includes(skill.name),
    );

    const helperCalls = ggSkills.flatMap((skill) =>
      skill.content
        .split("\n")
        .filter((line) => line.includes("<motion bin>/"))
        .map((line) => ({ skill: skill.name, line })),
    );

    expect(helperCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of helperCalls) {
      expect(call.line, call.skill).toMatch(/<node> "<motion bin>\//);
    }
  });

  it("gives the prompt and the sound skill the same default music source", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const prompt = buildMotionAgentPrompt(bundle);
    const sound = (await loadMotionSkills(bundle)).find((skill) => skill.name === "sound-design");

    // The bundled licensed track is the upbeat default in both places, and the
    // sound checkpoint offers it as a choice.
    expect(prompt).toContain("default to a bundled licensed track");
    expect(prompt).toMatch(/\*\*Sound\*\* — a bundled licensed track/);
    expect(prompt).not.toContain("synthesized music is the default");
    expect(sound?.description).toContain("bundled licensed recorded track");
    expect(sound?.content).toMatch(
      /\| No music given, upbeat \/ launch \/ playful \(default\) \| A brag track/,
    );
  });

  it("routes every workflow through video-qa's loudness step before delivery", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const skills = await loadMotionSkills(bundle);
    const motion = skills.find((skill) => skill.name === "motion");
    const qa = skills.find((skill) => skill.name === "video-qa");

    // Bundled workflows (brag, HyperFrames) have their own deliver steps that
    // skip loudness; the router must send them through video-qa anyway.
    expect(motion?.content).toContain("Whatever builds the video, finish with `video-qa`");
    // Renders land near -23 LUFS; the delivered file is normalized, and 320k
    // AAC keeps ffmpeg's encoder from overshooting the true-peak ceiling.
    expect(qa?.content).toContain("loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(qa?.content).toMatch(/-c:v copy[\s\S]*-c:a aac -b:a 320k/);
    expect(qa?.content).toContain("Apply Gate 4's loudness step to this render.");
  });

  it("opens the user's file manager at every delivered video, edits included", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const prompt = buildMotionAgentPrompt(bundle);
    const qa = (await loadMotionSkills(bundle)).find((skill) => skill.name === "video-qa");

    expect(prompt).toContain("then open the folder with the video selected");
    expect(prompt).toContain("then steps 7 and 8");
    expect(qa?.content).toContain('<node> "<motion bin>/reveal.mjs" renders/<file>.mp4');
  });

  it("gives font choice one owner and only names catalog items that exist", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const skills = await loadMotionSkills(bundle);
    const byName = (name: string): string => skills.find((s) => s.name === name)?.content ?? "";
    const catalog = JSON.parse(
      (
        await execFileAsync(process.execPath, [
          path.join(bundle.root, "bin", "hyperframes.mjs"),
          "catalog",
          "--json",
        ])
      ).stdout,
    ) as Array<{ name: string }>;
    const names = new Set(catalog.map((item) => item.name));

    // Brand/approved roles win; the type skill only fills unresolved choices.
    expect(byName("motion")).toContain("approved `frame.md` roles and required brand fonts win");
    expect(byName("motion")).toContain("`type-system` fills unresolved roles before approval");
    expect(byName("motion")).toContain("Keep Inter when it");
    // No GG skill falls back to a generic default headline font.
    for (const name of GG_MOTION_SKILLS) {
      expect(byName(name), name).not.toMatch(/if none, Inter/);
    }
    // Every catalog item the craft skills recommend is really installable.
    const toolkit = byName("visual-toolkit");
    const table = toolkit.slice(
      toolkit.indexOf("Starting points by job"),
      toolkit.indexOf("## 2."),
    );
    const skillNames = new Set(skills.map((skill) => skill.name));
    const recommended = [...table.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)]
      .map((m) => m[1] ?? "")
      .filter((item) => !skillNames.has(item));
    expect(recommended.length).toBeGreaterThan(40);
    for (const item of recommended) expect(names.has(item), item).toBe(true);
  });

  it("keeps every 3D example in the skills on the bundled, offline Three.js", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const skill = (await loadMotionSkills(bundle)).find((s) => s.name === "motion-3d");

    expect(skill?.content).toContain('<node> "<motion bin>/three.mjs" add .');
    expect(skill?.content).toContain("Never import Three.js from a\nCDN");
    expect(skill?.content).not.toMatch(/cdn\.jsdelivr|unpkg\.com|cdnjs/);
    // Every addon the skill names ships in the bundle.
    const manifest = JSON.parse(
      await fs.readFile(path.join(bundle.root, "vendor", "three", "three.json"), "utf8"),
    ) as { addons: string[] };
    const shipped = new Set(manifest.addons.map((a) => path.basename(a, ".js")));
    const listed = skill?.content.slice(
      skill.content.indexOf("Bundled addons:"),
      skill.content.indexOf("Never import Three.js"),
    );
    const named = [...(listed ?? "").matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(shipped.has(name), name).toBe(true);
  });

  it("points every video type at the shared music and SFX libraries on disk", async () => {
    const bundle = await findMotionBundle();
    if (!bundle) throw new Error("motion bundle missing");
    const prompt = buildMotionAgentPrompt(bundle);
    const sound = (await loadMotionSkills(bundle)).find((skill) => skill.name === "sound-design");

    // Real paths the agent can open, with real files behind them.
    const music = await fs.readdir(motionMusicDir(bundle));
    const cues = await fs.readdir(path.join(motionMusicDir(bundle), "cues"));
    const sfx = await fs.readdir(motionSfxDir(bundle));
    expect(prompt).toContain(motionMusicDir(bundle));
    expect(prompt).toContain(motionSfxDir(bundle));
    expect(music.some((file) => file.endsWith(".mp3"))).toBe(true);
    expect(cues.some((file) => file.endsWith(".music-cues.json"))).toBe(true);
    expect(sfx).toContain("sfx-analysis.md");

    // Framed as shared across workflows, with the hand-off into HyperFrames'
    // audio_meta-driven workflows documented.
    expect(prompt).toContain("## Shared audio (every video type)");
    // Render prerequisites stay under the HyperFrames section, not the audio one.
    const hyperframesSection = prompt.slice(
      prompt.indexOf("## HyperFrames in GG"),
      prompt.indexOf("## Shared audio"),
    );
    expect(hyperframesSection).toContain("doctor");
    expect(hyperframesSection).toContain("browser ensure");
    expect(sound?.content).toContain("shared by every kind of video");
    expect(sound?.content).toContain("## 6b. Hand the music to a HyperFrames workflow");
  });

  it("builds a Motion session with only its own skills and no coder behavior", async () => {
    const agent = await createMotionAgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
    });
    const options = optionsOf(agent);

    expect(options.agentPrompt).toContain("You are GG Motion");
    expect(options.agentRole).toBe("primary");
    expect(options.agentContext).toBe("none");
    expect(options.promptCacheKeyPrefix).toBe("ggmotion");
    expect(options.sessionRootDir).toBe(path.resolve("/tmp/gg/motion-sessions"));
    expect(options.coderSlashCommands).toBe(false);
    expect(options.projectCustomization).toBe(false);
    expect(options.loadExtensions).toBe(false);
    expect(options.contextLimits).toEqual({ skillCatalogBytes: MOTION_SKILL_CATALOG_BYTES });
    expect(options.onEnterPlan).toBeUndefined();
    const skillNames = (options.skills ?? []).map((skill) => skill.name);
    expect(skillNames).toEqual(expect.arrayContaining(GG_MOTION_SKILLS));
  });

  it("refuses to resume a session from outside the Motion namespace", async () => {
    const outside = await createMotionAgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
      sessionId: "/tmp/gg/sessions/project/coder-session.jsonl",
    });
    expect(optionsOf(outside).sessionId).toBeUndefined();

    const inside = path.resolve("/tmp/gg/motion-sessions/project/motion-session.jsonl");
    const resumed = await createMotionAgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
      sessionId: inside,
    });
    expect(optionsOf(resumed).sessionId).toBe(inside);
  });
});

describe("primary agent prompts", () => {
  it("omit the sub-agent return contract that delegated children keep", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-prompt-"));
    try {
      const base = { cwd: tmp, context: "none" as const };
      const child = await buildSubAgentSystemPrompt("You are a test agent.", base);
      const primary = await buildSubAgentSystemPrompt("You are a test agent.", {
        ...base,
        role: "primary",
      });

      expect(child).toContain(SUBAGENT_RETURN_CONTRACT);
      expect(primary).toContain("You are a test agent.");
      expect(primary).not.toContain(SUBAGENT_RETURN_CONTRACT);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
