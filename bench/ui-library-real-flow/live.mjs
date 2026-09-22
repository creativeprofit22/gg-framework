// Live GLM 5.3 real-flow supervisor. Holds the real API key and the budget;
// workers only ever see the broker. Usage: node live.mjs [--dry-run]
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import { startLiveBroker } from "./live-broker.mjs";
import { Budget } from "./budget.mjs";
import fsSync from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dist = path.join(repoRoot, "packages", "gcoder");
const ggcoderDist = path.join(repoRoot, "packages", "ggcoder", "dist");
const dryRun = process.argv.includes("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runsDir = path.join(here, "runs", `live-${stamp}`);

const CASES = [
  { id: "bklit-shimmer", prompt: "Use the Bklit shimmering-text component to add an animated headline to this Vite React app's home page. Keep the library's own styling, make sure it builds, and show it in App.tsx.", expected: { item: "bklit:shimmering-text" } },
  { id: "kokonut-cardflip", prompt: "Use Kokonut's card-flip component to build a small three-card feature section in this Vite React app. Preserve the library's styling and verify the build passes.", expected: { item: "kokonut:card-flip" } },
  { id: "motion-outcome", prompt: "Add a notification list to this app: items animate in when added and animate out when dismissed, and the animation respects the user's reduced-motion preference. Keep it accessible and make sure the build passes.", expected: { motion: true } },
  { id: "pricing-outcome", prompt: "Build a clean pricing section with three tiers for this app. Reuse existing project UI where possible, keep it responsive and accessible, and make sure the build passes.", expected: { any: true } },
  { id: "kokonut-drawer", prompt: "Use Kokonut's smooth-drawer component to add a settings drawer that opens from a button in the header and closes on Escape. Preserve the library's styling and verify the build.", expected: { item: "kokonut:smooth-drawer" } },
  { id: "bklit-shimmer-repeat", prompt: "Use the Bklit shimmering-text component to add an animated headline to this Vite React app's home page. Keep the library's own styling, make sure it builds, and show it in App.tsx.", expected: { item: "bklit:shimmering-text" } },
];

async function makeFixture(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "live-fixture",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build", typecheck: "tsc --noEmit" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: {
      vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0", typescript: "^5.6.0",
      tailwindcss: "^4.0.0", "@tailwindcss/vite": "^4.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0",
    },
  }, null, 2));
  await fs.writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext",
      moduleResolution: "bundler", jsx: "react-jsx", strict: true, skipLibCheck: true,
      noEmit: true, baseUrl: ".", paths: { "@/*": ["./src/*"] }, types: ["vite/client"],
    },
    include: ["src", "vite.config.ts"],
  }, null, 2));
  await fs.writeFile(path.join(dir, "vite.config.ts"),
    'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport tailwindcss from "@tailwindcss/vite";\n\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n');
  await fs.writeFile(path.join(dir, "components.json"), JSON.stringify({
    $schema: "https://ui.shadcn.com/schema.json", style: "new-york", rsc: false, tsx: true,
    tailwind: { config: "", css: "src/index.css", baseColor: "neutral", cssVariables: true },
    aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
    iconLibrary: "lucide",
  }, null, 2));
  await fs.writeFile(path.join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
  await fs.writeFile(path.join(dir, "src", "index.css"), '@import "tailwindcss";\n');
  await fs.writeFile(path.join(dir, "src", "App.tsx"), 'export default function App() {\n  return <main className="p-8"><h1 className="text-2xl font-semibold">Fixture App</h1></main>;\n}\n');
  await fs.writeFile(path.join(dir, "src", "main.tsx"),
    'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
}

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 300_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out: out.slice(-4000), err: err.slice(-4000) }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, out, err: String(error) }); });
  });
}

/** sandbox-exec aborts (SIGABRT) on some macOS builds; probe once and fall
 *  back to environment-level isolation when it cannot run. */
async function sandboxAvailable() {
  const probe = await new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", '(version 1)(deny default)(allow process-exec)', "/usr/bin/true"]);
    child.on("exit", (code, signal) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  return probe;
}

async function sandboxProfile({ workspace, home, readRoots, brokerPort, npmIps }) {
  const quote = (value) => JSON.stringify(value);
  return `(version 1)
(deny default)
(allow process-exec process-fork signal sysctl-read mach-lookup)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library/Apple") (subpath "/dev") (literal "/private/etc/localtime"))
${[...new Set([workspace, home, ...readRoots])].map((root) => `(allow file-read* (subpath ${JSON.stringify(root)}))`).join("\n")}
(allow file-write* (subpath ${JSON.stringify(workspace)}) (subpath ${JSON.stringify(home)}) (literal "/dev/null"))
(allow network-outbound (remote ip "localhost:${brokerPort}") (remote tcp "*:443"))`;
}

function launchWorker({ useSandbox, profile, env, cwd }) {
  if (useSandbox) return spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, path.join(here, "live-worker.mjs")], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  // Fallback: environment isolation only (isolated HOME/GG_HOME/cwd; no real
  // credential in env; broker bound to loopback with a per-launch token).
  return spawn(process.execPath, [path.join(here, "live-worker.mjs")], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

async function lineOverlap(hostedText, fileText) {
  const hosted = hostedText.split("\n").map((l) => l.trim()).filter((l) => l.length > 12);
  if (!hosted.length) return 0;
  const fileLines = new Set(fileText.split("\n").map((l) => l.trim()));
  let hits = 0;
  for (const line of hosted) if (fileLines.has(line)) hits++;
  return hits / hosted.length;
}

async function listFiles(root, base = "") {
  const entries = await fs.readdir(path.join(root, base), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, rel)));
    else files.push(rel);
  }
  return files;
}

async function hostChecks(project, expected) {
  const checks = {};
  const files = (await listFiles(project)).filter((f) => /\.(tsx?|jsx?|css)$/.test(f) && !f.startsWith("runs/"));
  checks.generatedFiles = files;
  if (expected.item) {
    const provider = expected.item.split(":")[0];
    const name = expected.item.split(":")[1];
    const url = provider === "bklit" ? `https://ui.bklit.com/r/${name}.json` : `https://kokonutui.com/r/${name}.json`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const payload = await response.json();
      checks.registryFetched = true;
      let best = { ratio: 0, file: null };
      for (const file of files) {
        const text = await fs.readFile(path.join(project, file), "utf8");
        for (const rf of payload.files ?? []) {
          if (typeof rf.content !== "string") continue;
          const ratio = await lineOverlap(rf.content, text);
          if (ratio > best.ratio) best = { ratio, file };
        }
      }
      checks.sourceProvenance = best;
    } catch (error) {
      checks.registryFetched = false;
      checks.registryError = String(error);
    }
    const stem = name.replace(/[^a-z0-9]/gi, "-");
    // Real consumers: other project files whose CONTENT actually imports/renders
    // the adopted component — not merely files that exist.
    checks.consumerImports = [];
    for (const file of files) {
      if (file.toLowerCase().includes(stem.toLowerCase().slice(0, 8))) continue;
      const text = await fs.readFile(path.join(project, file), "utf8");
      if (new RegExp(`from ["'].*${stem}|<[^>]*${stem.replace(/-/g, "[-_]?")}`, "i").test(text) || text.includes(`/${stem}`) || text.includes(stem)) {
        checks.consumerImports.push(file);
      }
    }
  }
  const typecheck = await run("npm", ["run", "typecheck"], { cwd: project, timeoutMs: 240_000 });
  checks.typecheck = { pass: typecheck.code === 0, tail: typecheck.out + typecheck.err };
  const build = await run("npm", ["run", "build"], { cwd: project, timeoutMs: 240_000 });
  checks.build = { pass: build.code === 0, tail: (build.out + build.err).slice(-2000) };
  return checks;
}

async function main() {
  const auth = JSON.parse(await fs.readFile(path.join(process.env.HOME, ".gg", "auth.json"), "utf8"));
  const apiKey = auth?.glm?.accessToken;
  if (!apiKey) throw new Error("No GLM credential in supervising auth file");
  await fs.mkdir(runsDir, { recursive: true });
  const npmIps = [...new Set((await dns.lookup("registry.npmjs.org", { all: true })).map((r) => r.address))];
  const summary = { started: new Date().toISOString(), dryRun, cases: [] };
  const nodeBinDir = path.dirname(process.execPath);
  const useSandbox = await sandboxAvailable();
  summary.sandbox = useSandbox ? "sandbox-exec" : "environment-only (sandbox-exec unavailable on this OS build)";
  let budgetTotal = { requests: 0, tokens: 0 };
  // ONE budget across all cases: per-case brokers must share it so the global
  // approved ceiling actually spans the batch (the first live batch overran
  // because each case silently got a fresh budget).
  const approvalRecords = JSON.parse(fsSync.readFileSync(path.join(here, "live-approval.json"), "utf8")).records;
  const caps = JSON.parse(fsSync.readFileSync(path.join(here, "live-approval.json"), "utf8")).records.find((r) => r.kind === "question").options.find((o) => o.id === "first-batch").caps;
  const sharedBudget = dryRun || process.argv.includes("--boot-test") ? undefined : new Budget(approvalRecords);

  const cases = dryRun || process.argv.includes("--boot-test") ? CASES.slice(0, 1) : CASES;
  for (const scenario of cases) {
    if (!dryRun && !process.argv.includes("--boot-test")) {
      const spent = sharedBudget.ledger.requests.length;
      const tokens = sharedBudget.ledger.requests.reduce((a, r) => a + (r.usage ? r.usage.input + r.usage.cacheRead + r.usage.output : r.reserved), 0);
      if (spent >= caps.requests || tokens >= caps.tokens) { summary.cases.push({ id: scenario.id, skipped: "approved ceiling reached before this case" }); continue; }
    }
    const caseDir = path.join(runsDir, scenario.id);
    const project = path.join(caseDir, "project");
    const home = path.join(caseDir, "home");
    await fs.mkdir(home, { recursive: true });
    process.stdout.write(`[${scenario.id}] fixture + install...\n`);
    await makeFixture(project);
    const install = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: project, timeoutMs: 420_000 });
    if (install.code !== 0) { summary.cases.push({ id: scenario.id, failed: "fixture npm install failed", log: install.err }); continue; }

    if (process.argv.includes("--boot-test")) {
      const caseFile = path.join(caseDir, "case.json");
      const outFile = path.join(caseDir, "worker-result.json");
      await fs.writeFile(caseFile, JSON.stringify({ ...scenario, prompt: "Say hi." }));
      const broker = await startLiveBroker({
        approvalPath: path.join(here, "live-approval.json"),
        apiKey: "unused-boot-test",
        ledgerPath: path.join(caseDir, "ledger.json"),
        enabled: false,
      });
      const profile = await sandboxProfile({
        workspace: project, home, readRoots: [repoRoot, nodeBinDir], brokerPort: new URL(broker.url).port, npmIps,
      });
      const outFileFinal = outFile;
      const worker = launchWorker({
        useSandbox,
        profile,
        cwd: project,
        env: {
          HOME: home, GG_HOME: home, TMPDIR: home, PATH: `/usr/bin:/bin:${nodeBinDir}`,
          GG_LIVE_BROKER_PORT: new URL(broker.url).port, GG_LIVE_BROKER_TOKEN: broker.token,
          GG_LIVE_CASE_FILE: caseFile, GG_LIVE_OUT_FILE: outFileFinal,
        },
      });
      let log = "";
      worker.stdout.on("data", (d) => { log += d; });
      worker.stderr.on("data", (d) => { log += d; });
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => worker.kill("SIGKILL"), 90_000);
        worker.on("exit", (c) => { clearTimeout(timer); resolve(c); });
      });
      await broker.close();
      let result = null;
      try { result = JSON.parse(await fs.readFile(outFileFinal, "utf8")); } catch { }
      await fs.writeFile(path.join(caseDir, "worker-log.txt"), log.slice(-20000));
      const bootOk = broker.stats.hits > 0 && broker.stats.unauthorized === 0 && result?.error;
      summary.cases.push({ id: scenario.id, bootTest: true, exitCode: code, brokerHits: broker.stats.hits, unauthorized: broker.stats.unauthorized, sessionInitializedAndReachedBroker: bootOk, resultError: result?.error?.slice(0, 300) ?? "(killed during model retries: expected with disabled broker)" });
      console.log(`[${scenario.id}] boot-test exit=${code} hits=${broker.stats.hits} unauthorized=${broker.stats.unauthorized} ok=${bootOk}`);
      continue;
    }

    if (dryRun) {
      const checks = await hostChecks(project, scenario.expected ?? {});
      summary.cases.push({ id: scenario.id, dryRun: true, checks: { build: checks.build, typecheck: checks.typecheck } });
      continue;
    }

    const caseFile = path.join(caseDir, "case.json");
    const outFile = path.join(caseDir, "worker-result.json");
    await fs.writeFile(caseFile, JSON.stringify(scenario));
    const runId = sharedBudget.startRun({ maxRequests: 30, timeoutMs: 15 * 60_000 });
    const broker = await startLiveBroker({
      approvalPath: path.join(here, "live-approval.json"),
      apiKey,
      ledgerPath: path.join(caseDir, "ledger.json"),
      budget: sharedBudget,
      runId,
    });
    const profile = await sandboxProfile({
      workspace: project, home, readRoots: [repoRoot, nodeBinDir], brokerPort: new URL(broker.url).port, npmIps,
    });
    process.stdout.write(`[${scenario.id}] worker (broker :${new URL(broker.url).port})...\n`);
    const started = Date.now();
    const worker = launchWorker({
      useSandbox,
      profile,
      cwd: project,
      env: {
        HOME: home, GG_HOME: home, TMPDIR: home, PATH: `/usr/bin:/bin:${nodeBinDir}`,
        GG_LIVE_BROKER_PORT: new URL(broker.url).port, GG_LIVE_BROKER_TOKEN: broker.token,
        GG_LIVE_CASE_FILE: caseFile, GG_LIVE_OUT_FILE: outFile,
      },
    });
    let workerLog = "";
    worker.stdout.on("data", (d) => { workerLog += d; });
    worker.stderr.on("data", (d) => { workerLog += d; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => worker.kill("SIGKILL"), 15 * 60_000);
      worker.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    const seconds = (Date.now() - started) / 1000;
    await broker.close();
    const ledger = JSON.parse(await fs.readFile(path.join(caseDir, "ledger.json"), "utf8"));
    const used = ledger.requests.reduce((acc, r) => ({
      requests: acc.requests + 1,
      tokens: acc.tokens + (r.usage ? r.usage.input + r.usage.cacheRead + r.usage.output : r.reserved),
    }), { requests: 0, tokens: 0 });
    budgetTotal.requests += used.requests;
    budgetTotal.tokens += used.tokens;

    let workerResult = null;
    try { workerResult = JSON.parse(await fs.readFile(outFile, "utf8")); } catch { }
    const checks = await hostChecks(project, scenario.expected ?? {});
    await fs.writeFile(path.join(caseDir, "worker-log.txt"), workerLog.slice(-20000));
    summary.cases.push({
      id: scenario.id, exitCode: exit, seconds,
      usage: used,
      toolCalls: workerResult?.toolCalls ?? [],
      error: workerResult?.error ?? null,
      checks,
    });
    process.stdout.write(`[${scenario.id}] exit=${exit} ${seconds.toFixed(0)}s reqs=${used.requests} tokens=${used.tokens} build=${checks.build.pass} typecheck=${checks.typecheck.pass}\n`);
  }
  summary.budgetTotal = budgetTotal;
  summary.finished = new Date().toISOString();
  await fs.writeFile(path.join(runsDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nSummary → ${path.join(runsDir, "summary.json")}`);
  console.log(`Totals: requests=${budgetTotal.requests}/120 tokens=${budgetTotal.tokens}/2000000 (ceiling 6 runs)`);
}

main().catch((error) => { console.error(error); process.exit(1); });
