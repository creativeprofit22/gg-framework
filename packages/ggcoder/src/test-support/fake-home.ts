/**
 * Point `os.homedir()` at a throwaway directory, on every platform.
 *
 * Tests that isolate `~/.gg` (auth.json, settings, session store) used to set
 * `process.env.HOME` alone. That silently does NOTHING on Windows: libuv
 * resolves the home directory from `USERPROFILE`, falling back to
 * `HOMEDRIVE`+`HOMEPATH`, and ignores `HOME` entirely. So on Windows those
 * tests kept reading the REAL user profile — which on a fresh CI runner has no
 * credentials, hence a wave of `NotLoggedInError` failures, and on a developer
 * machine means a test could read (or overwrite) real auth tokens.
 *
 * This is the same trap that made the desktop app come up logged out with an
 * empty project picker: the Rust shell preferred `HOME` while the Node sidecar
 * used `USERPROFILE`, so the two disagreed about where `~` was.
 *
 * Sets every variable libuv consults and returns a restore function that puts
 * the previous values back exactly, including "was not set".
 */
export function useFakeHome(dir: string): () => void {
  const vars = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
  const previous = new Map<string, string | undefined>(vars.map((v) => [v, process.env[v]]));

  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // HOMEDRIVE/HOMEPATH are only consulted when USERPROFILE is unset, but a
  // stale pair pointing at the real profile is a trap worth removing outright.
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
