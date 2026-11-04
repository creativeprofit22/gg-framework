import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const canonicalSetupSweepCommandPath = fileURLToPath(
  new URL("../assets/commands/setup-sweep.md", import.meta.url),
);

// The generated /sweep runs these from <agentDir>/scripts; the ledger imports the planner.
export const canonicalSweepScriptPaths = ["sweep-plan.mjs", "sweep-ledger.mjs"].map((name) =>
  fileURLToPath(new URL(`../assets/scripts/${name}`, import.meta.url)),
);

function resolveAgentDir(agentDir = process.env.GG_AGENT_DIR || path.join(homedir(), ".gg")) {
  if (!path.isAbsolute(agentDir)) throw new Error("GG_AGENT_DIR must be absolute");
  return path.normalize(agentDir);
}

export function resolveSetupSweepCommandTarget(agentDir) {
  return path.join(resolveAgentDir(agentDir), "commands", "setup-sweep.md");
}

export function resolveSweepScriptsDir(agentDir) {
  return path.join(resolveAgentDir(agentDir), "scripts");
}

async function installFile(sourcePath, target, label) {
  const source = await readFile(sourcePath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`${label} path must be a real directory: ${directory}`);
  }

  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }

  return {
    source: sourcePath,
    target,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export async function installSetupSweepCommand({ agentDir } = {}) {
  const command = await installFile(
    canonicalSetupSweepCommandPath,
    resolveSetupSweepCommandTarget(agentDir),
    "Commands",
  );
  const scriptsDir = resolveSweepScriptsDir(agentDir);
  const scripts = [];
  for (const sourcePath of canonicalSweepScriptPaths) {
    scripts.push(
      await installFile(sourcePath, path.join(scriptsDir, path.basename(sourcePath)), "Scripts"),
    );
  }
  return { ...command, scripts };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await installSetupSweepCommand();
  console.log(`Installed /setup-sweep: ${result.target}`);
  console.log(`Canonical source: ${result.source}`);
  console.log(`SHA-256: ${result.sha256}`);
  for (const script of result.scripts) {
    console.log(`Installed script: ${script.target}`);
    console.log(`SHA-256: ${script.sha256}`);
  }
}
