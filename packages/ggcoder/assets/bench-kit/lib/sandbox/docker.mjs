// @ts-check
// Optional docker sandbox for untrusted candidates. Used only when the study
// asks for it AND a docker daemon is detected; the kit never installs or
// pulls anything by itself (`--pull never`). Each sample runs with:
//   no network, read-only root filesystem, all capabilities dropped,
//   no-new-privileges, a pids limit, a memory limit, and a tmpfs /tmp.
// The project is mounted read-only at /project, the copied input read-only at
// /bench/input, and only /bench/out is writable.
// Peak memory is not sampled here (the watched process would be the docker
// CLI, not the candidate), so reports say "unmeasured in docker".
import { defaultExec } from "../provenance.mjs";

export const CONTAINER = Object.freeze({
  project: "/project",
  input: "/bench/input",
  out: "/bench/out",
  expected: "/bench/expected",
});

/**
 * Is a docker daemon reachable? Never guesses.
 * @param {{ exec?: import("../provenance.mjs").Exec }} [options]
 * @returns {Promise<{ available: boolean, version: string | null, reason?: string }>}
 */
export async function detectDocker({ exec = defaultExec } = {}) {
  const res = await exec("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 15_000,
  });
  const version = res.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  if (res.ok && version) return { available: true, version };
  return {
    available: false,
    version: null,
    reason: res.error ? `docker not available: ${res.error}` : "docker daemon did not answer",
  };
}

/**
 * Build the `docker run` argv for one command.
 * @param {{
 *   image: string, argv: string[], projectDir: string, inputDir: string, outDir: string, expectedDir?: string,
 *   workdir?: string, network?: "none" | "bridge", memory?: string, pids?: number, cpus?: number, env?: Record<string, string>,
 *   passEnv?: string[],
 * }} options
 * @returns {string[]}
 */
export function dockerRunArgv(options) {
  const {
    image,
    argv,
    projectDir,
    inputDir,
    outDir,
    expectedDir,
    workdir = CONTAINER.project,
    network = "none",
    memory = "2g",
    pids = 256,
    cpus,
    env = {},
    passEnv = [],
  } = options;
  const mount = (/** @type {string} */ source, /** @type {string} */ target, readonly = true) => [
    "--mount",
    `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
  ];
  return [
    "docker",
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=512m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pids),
    "--memory",
    memory,
    ...(cpus ? ["--cpus", String(cpus)] : []),
    ...mount(projectDir, CONTAINER.project),
    ...mount(inputDir, CONTAINER.input),
    ...mount(outDir, CONTAINER.out, false),
    ...(expectedDir ? mount(expectedDir, CONTAINER.expected) : []),
    ...Object.keys(env)
      .sort()
      .flatMap((k) => ["--env", `${k}=${env[k]}`]),
    // Pass-through variables go by name only: docker copies the value from its
    // own (already scrubbed) environment, so secrets never appear in argv.
    ...[...new Set(passEnv)]
      .filter((k) => !(k in env))
      .sort()
      .flatMap((k) => ["--env", k]),
    "--workdir",
    workdir,
    image,
    ...argv,
  ];
}
