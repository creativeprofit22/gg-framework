import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../assets/bench-kit/cli.mjs";
import { splitCommand } from "../assets/bench-kit/lib/argv.mjs";
import { KIT_VERSION } from "../assets/bench-kit/lib/version.mjs";
import {
  buildKitManifest,
  canonicalBenchKitDir,
  canonicalSetupBenchCommandPath,
  installSetupBenchCommand,
  POINTER_FILE,
  resolveSetupBenchCommandTarget,
} from "./install-setup-bench-command.mjs";

const node = process.execPath;
const command = await readFile(canonicalSetupBenchCommandPath, "utf8");
const router = await readFile(path.join(canonicalBenchKitDir, "templates", "bench.md"), "utf8");
const playbookDir = path.join(canonicalBenchKitDir, "playbooks");
const playbooks = Object.fromEntries(
  await Promise.all(
    (await readdir(playbookDir)).map(async (f) => [
      f,
      await readFile(path.join(playbookDir, f), "utf8"),
    ]),
  ),
);

/** Run a command without a shell. */
const run = (argv, cwd) =>
  new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });

/** The selftest JSON of a kit folder. */
async function selftestOf(kitDir, cwd = kitDir) {
  const r = await run([node, path.join(kitDir, "cli.mjs"), "selftest"], cwd);
  return { code: r.code, out: JSON.parse(r.stdout) };
}

const checkNamed = (out, name) => (out.checks ?? out.error.details).find((c) => c.name === name);

test("setup-bench keeps its non-negotiables and generator workflow", () => {
  assert.match(command, /allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, ask_user/);
  for (const rule of [
    /Do \*\*not\*\* install, download or update anything .* without\s+the user's explicit confirmation/,
    /Never edit product code/,
    /Never run paid or live candidates here/,
    /Never overwrite a locally modified kit or an existing `.gg\/commands\/bench.md` without asking/,
    /Plain language in every message/,
    /The kit's CLI does all counting and statistics/,
  ])
    assert.match(command, rule);
  for (const step of [
    "## Step 1: Detect project shape",
    "## Step 2: Locate the installed kit",
    "## Step 3: Ask which study kinds to expect",
    "## Step 4: Vendor the kit into `bench/kit/`",
    "## Step 5: Write the config and the `/bench` router",
    "## Step 6: Propose `.gitignore` lines (ask first)",
    "## Step 7: Selftest",
    "## Step 8: Re-read what was generated",
    "## Step 9: Report",
  ])
    assert.ok(command.includes(step), `missing ${step}`);
  assert.match(command, /Node 22 or newer/);
  assert.match(command, /<agent dir>\/bench-kit\/current\.json/);
  assert.match(command, /Locally modified kit.*never\s+overwrite silently/s);
  assert.match(command, /bench\/studies\/\*\/runs\//);
  assert.match(command, /ask with `ask_user` before editing `.gitignore`/);
  assert.match(command, /End with: `Next: \/bench new <your question>`/);
  assert.equal(command.includes("\r"), false);
});

test("the vendoring commands in setup-bench copy a verified kit into a project", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-bench-agent-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "gg-bench-project-"));
  try {
    const installed = await installSetupBenchCommand({ agentDir });
    const block = /## Step 4[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(command);
    assert.ok(block, "Step 4 has a bash block");
    const lines = block[1].split("\n");
    assert.equal(lines.length, 3);
    await mkdir(path.join(projectDir, "bench"), { recursive: true });
    for (const line of lines) {
      const argv = splitCommand(
        line.replace("<agent dir>/bench-kit/<dir>", installed.kit.dir.split(path.sep).join("/")),
      );
      assert.ok(argv.ok, line);
      const r = await run(argv.value, projectDir);
      assert.equal(r.code, 0, `${line}\n${r.stderr}`);
    }
    const st = await selftestOf(path.join(projectDir, "bench", "kit"), projectDir);
    assert.equal(st.code, 0, JSON.stringify(st.out));
    assert.equal(checkNamed(st.out, "manifest").status, "pass");
    assert.deepEqual(await readdir(path.join(projectDir, "bench")), ["kit"]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("the /bench router stays thin and loads only playbooks that ship with the kit", () => {
  assert.ok(router.split("\n").length < 80, "router must stay under 80 lines");
  assert.match(router, /^---\nargument-hint: .+\ndescription: .+\nallowed-tools: .+\n---\n/);
  for (const placeholder of ["<project summary>", "<kit version>"])
    assert.equal(router.split(placeholder).length, 2, `${placeholder} appears exactly once`);
  const referenced = [...router.matchAll(/bench\/kit\/playbooks\/([a-z-]+\.md)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(referenced)].sort(), [
    "agent-studies.md",
    "explain.md",
    "new-study.md",
    "rate.md",
    "report.md",
    "run.md",
  ]);
  for (const file of referenced) assert.ok(playbooks[file], `${file} ships with the kit`);
  for (const mode of ["new", "run", "report", "explain", "rate", "list"])
    assert.match(router, new RegExp(`\\| \`${mode}\`\\s+\\|`));
  assert.match(router, /The kit CLI does all counting and statistics/);
  assert.match(router, /never described as a win/);
  assert.match(router, /through `ask_user`/);
});

test("every CLI command written in the playbooks and router parses", () => {
  const sources = { "templates/bench.md": router, ...playbooks };
  let count = 0;
  for (const [file, text] of Object.entries(sources))
    for (const m of text.matchAll(/node bench\/kit\/cli\.mjs ([^`\n]+)/g)) {
      if (m[1].startsWith("<command>")) continue; // the router's generic usage line
      const argv = splitCommand(/** @type {string} */ (m[1]).replace(/\s+\[.*$/, "").trim());
      assert.ok(argv.ok, `${file}: ${m[1]}`);
      assert.doesNotThrow(() => parseArgs(argv.value), `${file}: ${m[1]}`);
      count++;
    }
  assert.ok(count >= 15, `found ${count} commands`);
});

test("the playbooks carry the plain-language, honesty and spend rules", () => {
  assert.match(playbooks["new-study.md"], /Explainer card per candidate/);
  assert.match(playbooks["new-study.md"], /Do not freeze until the user confirms/);
  assert.match(playbooks["new-study.md"], /LLM judges are never gates/);
  assert.match(
    playbooks["run.md"],
    /Order: validate → freeze → spend approval \(paid only\) → A\/A → pilot → full run/,
  );
  assert.match(playbooks["run.md"], /--cap-usd <amount> --approved-by/);
  assert.match(playbooks["run.md"], /Never lower `perSampleWorstCase` to make it fit/);
  assert.match(playbooks["report.md"], /Never call a TIE, NO-WIN or INCONCLUSIVE a win/);
  assert.match(playbooks["explain.md"], /study's own\s+numbers first and the glossary second/);
  assert.match(playbooks["rate.md"], /stored\s+OUTSIDE the pack folder/);
  assert.match(playbooks["agent-studies.md"], /Terms of service first/);
  assert.match(playbooks["agent-studies.md"], /held-out/);
});

test("the kit manifest hashes every shipped file and kit names avoid test-file tokens", async () => {
  const manifest = await buildKitManifest();
  assert.equal(manifest.kitVersion, KIT_VERSION);
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await buildKitManifest(), manifest, "the manifest is deterministic");
  const paths = manifest.files.map((f) => f.path);
  for (const required of [
    "cli.mjs",
    "glossary.json",
    "lib/pipeline.mjs",
    "lib/adapters/agent.mjs",
    "lib/budget.mjs",
    "templates/bench.md",
    "templates/study.sample.json",
    "templates/task.sample/task.json",
    "playbooks/run.md",
  ])
    assert.ok(paths.includes(required), `${required} is in the manifest`);
  assert.ok(!paths.includes("manifest.json"));
  const first = manifest.files.find((f) => f.path === "cli.mjs");
  const bytes = await readFile(path.join(canonicalBenchKitDir, "cli.mjs"));
  assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
  // gg-app/scripts/bundle-sidecar.mjs classifies these names as test files.
  const testDir = /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?|benchmarks?)(?:\/|$)/;
  const testName = /(?:^|[._-])(?:test|spec|fixture|example|benchmark)(?:[._-]|$)/;
  for (const p of paths) {
    assert.doesNotMatch(p, testDir, p);
    assert.doesNotMatch(path.posix.basename(p), testName, p);
  }
});

test("installs the command and a verified kit build, then reuses and repairs it", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-bench-install-"));
  try {
    const first = await installSetupBenchCommand({ agentDir });
    assert.equal(first.target, path.join(agentDir, "commands", "setup-bench.md"));
    assert.equal(await readFile(first.target, "utf8"), command);
    assert.equal(first.sha256, createHash("sha256").update(command).digest("hex"));
    assert.equal(first.kit.reused, false);
    const pointer = JSON.parse(
      await readFile(path.join(agentDir, "bench-kit", POINTER_FILE), "utf8"),
    );
    assert.equal(pointer.kitVersion, KIT_VERSION);
    assert.equal(pointer.dir, `${KIT_VERSION}-${pointer.digest.slice(0, 8)}`);
    assert.equal(first.kit.dir, path.join(agentDir, "bench-kit", pointer.dir));

    const st = await selftestOf(first.kit.dir);
    assert.equal(st.code, 0, JSON.stringify(st.out));
    assert.equal(checkNamed(st.out, "manifest").status, "pass");
    assert.equal(st.out.kitVersion, KIT_VERSION);

    const again = await installSetupBenchCommand({ agentDir });
    assert.equal(again.kit.reused, true);
    assert.deepEqual(
      (await readdir(path.join(agentDir, "bench-kit"))).sort(),
      [POINTER_FILE, pointer.dir].sort(),
      "no temporary build folders are left behind",
    );

    // A locally changed kit fails its selftest; reinstalling repairs the build.
    await writeFile(path.join(first.kit.dir, "glossary.json"), "{}\n");
    const broken = await selftestOf(first.kit.dir);
    assert.equal(broken.code, 1);
    assert.match(checkNamed(broken.out, "manifest").detail, /glossary\.json changed/);
    const repaired = await installSetupBenchCommand({ agentDir });
    assert.equal(repaired.kit.reused, false);
    assert.equal((await selftestOf(first.kit.dir)).code, 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("rejects a relative GG_AGENT_DIR", async () => {
  assert.throws(() => resolveSetupBenchCommandTarget("relative/agent"), /must be absolute/);
  await assert.rejects(
    installSetupBenchCommand({ agentDir: "relative/agent" }),
    /must be absolute/,
  );
});
