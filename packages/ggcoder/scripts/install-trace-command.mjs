import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const canonicalTraceCommandPath = fileURLToPath(
  new URL("../assets/commands/trace.md", import.meta.url),
);

export function resolveTraceCommandTarget(
  agentDir = process.env.GG_AGENT_DIR || path.join(homedir(), ".gg"),
) {
  if (!path.isAbsolute(agentDir)) throw new Error("GG_AGENT_DIR must be absolute");
  return path.join(path.normalize(agentDir), "commands", "trace.md");
}

export async function installTraceCommand({ agentDir } = {}) {
  const source = await readFile(canonicalTraceCommandPath);
  const target = resolveTraceCommandTarget(agentDir);
  const commandsDir = path.dirname(target);
  await mkdir(commandsDir, { recursive: true, mode: 0o700 });

  const directoryInfo = await lstat(commandsDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Commands path must be a real directory: ${commandsDir}`);
  }

  const temporary = path.join(commandsDir, `.trace.md.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }

  return {
    source: canonicalTraceCommandPath,
    target,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await installTraceCommand();
  console.log(`Installed /trace: ${result.target}`);
  console.log(`Canonical source: ${result.source}`);
  console.log(`SHA-256: ${result.sha256}`);
}
