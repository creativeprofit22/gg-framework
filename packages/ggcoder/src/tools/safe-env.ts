/** Environment variables safe to inherit. Everything else is stripped to prevent leaking secrets to LLM/tool output. */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "NO_COLOR",
  "FORCE_COLOR",
  // Development toolchains
  "NODE_PATH",
  "NVM_DIR",
  "NPM_CONFIG_PREFIX",
  "PNPM_HOME",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_DEFAULT_ENV",
  "CONDA_PREFIX",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "RUBY_VERSION",
  "GEM_HOME",
  "RBENV_ROOT",
  // Windows essentials. Without these, child processes (cmd.exe, Git Bash,
  // node, npm, MCP stdio servers) misbehave or fail to spawn: SystemRoot +
  // PATHEXT are required by the Windows loader/resolver, ComSpec is the
  // cmd.exe path, and the USERPROFILE/APPDATA/TEMP family is where toolchains
  // read and write. Stripping them was a silent cause of broken shell calls.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // Git Bash override for the agent shell (see core/shell.ts).
  "GG_BASH",
]);

/** Never pass native Token Plan auth to external tools, including explicit MCP env overrides.
 * Case-insensitive because Windows environment names are case-insensitive.
 */
export function withoutQwenRuntimeSecret(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([name]) => name.toUpperCase() !== "QWEN_CLOUD_TOKEN_PLAN_KEY",
    ),
  );
}

/** Only trusted ggcoder agent workers may inherit the dedicated inference credential. */
export function getTrustedAgentEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = withoutQwenRuntimeSecret(sourceEnv);
  if (sourceEnv.QWEN_CLOUD_TOKEN_PLAN_KEY !== undefined) {
    env.QWEN_CLOUD_TOKEN_PLAN_KEY = sourceEnv.QWEN_CLOUD_TOKEN_PLAN_KEY;
  }
  return env;
}

export function getSafeToolEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb", GG_CODER: "true" };
  for (const key of ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value) env[key] = value;
  }
  return env;
}
