# Adapters

An adapter runs one sample of one candidate. Each candidate in `study.json`
names its adapter in `candidates[].adapter.type`. The kit has five:

| Type       | Use it for                                                       |
| ---------- | ---------------------------------------------------------------- |
| `function` | Comparing functions in the project, timed in process.            |
| `cli`      | Comparing commands, tools, engines or scripts.                   |
| `http`     | Comparing services that are already running.                     |
| `agent`    | Comparing headless coding agents on task bundles.                |
| `manual`   | Numbers measured outside the kit (a phone, a lab rig, a vendor). |

See [concepts.md](concepts.md) for samples, gates and metrics, and
[study-format.md](study-format.md) for the rest of `study.json`.

## How a sample runs

- Every sample runs in a fresh Node worker process (`lib/worker.mjs`). One
  candidate's JIT state, caches and leaks never reach the next sample.
- The result goes back to the parent over IPC, so candidate output on stdout
  never mixes with it.
- Each sample gets its own folder under the run:
  `samples/<index>-<candidate>-<item>/` with `input/` (a copy of the workload
  item), `out/` and `tmp/`.
- The time limit per sample is `timeoutMs` from the study. The default is
  600000 ms (10 minutes).
- A sample either completes (`ok`, with metrics) or is errored with a `code`
  and a `message`. Errored samples count against the candidate's error rate.
- Metrics an adapter could not take are left out of the result. They are
  reported as unmeasured, never as zero.

### Commands never use a shell

`lib/argv.mjs` splits a command string into argv. Commands then run directly,
with no shell expansion, pipes or globbing.

- A command can be a string or an array of strings.
- `"double"` and `'single'` quotes group words. Backslash escapes work only
  inside double quotes, so Windows paths keep their backslashes.
- Slots such as `{input}` are filled after splitting. A path with spaces stays
  one argument.
- A slot with no value for this sample is an error (`SLOT_UNAVAILABLE`), never
  an empty string. An unknown slot name is rejected when the study is checked.
- On Windows, `.cmd` and `.bat` shims (for example `npx`) need
  `["cmd", "/c", ...]`. Otherwise the spawn fails with `COMMAND_NOT_FOUND`.

Errors from splitting: `ARGV_INVALID` (empty or not a string/array) and
`ARGV_QUOTE` (unclosed quote).

## Sandboxes

The study chooses one with `"sandbox": { "type": "process" | "docker" }`.
`process` is the default.

### process (default)

`lib/sandbox/process.mjs`. Isolation against accidents, not a security
boundary.

- **Temp copy.** The workload item is copied into `input/`, so a candidate
  cannot change the frozen workload.
- **Scrubbed environment.** Only an allowlist of OS basics survives (`PATH`,
  `PATHEXT`, `SystemRoot`, `HOME`, `USERPROFILE`, `APPDATA`, `LANG`, `TZ`,
  `TERM` and similar). API keys and test-runner context such as
  `NODE_OPTIONS` never leak in. `TEMP`, `TMP` and `TMPDIR` point at the
  sample's `tmp/`. Variable names are case-insensitive on Windows.
- **Timeout.** When the limit passes, the whole process tree is killed
  (`taskkill /T /F` on Windows, the process group elsewhere).
- **Capture.** stdout and stderr are written to files, capped at 16 MiB each
  (`truncated` is set when the cap is hit). The last 8 KiB of each is kept in
  the sample info.

### docker (only when asked for)

`lib/sandbox/docker.mjs`. For untrusted `cli` candidates.

- Used only when the study sets `"type": "docker"` and a daemon answers
  `docker version`. If not, `run` refuses with `SANDBOX_UNAVAILABLE` before
  any sample runs. There is no silent fallback to `process`.
- The kit never installs or pulls images: it runs with `--pull never`. The
  image must already be present.
- Each sample: `--rm`, read-only root filesystem, `--cap-drop ALL`,
  `no-new-privileges`, a 512 MB tmpfs `/tmp`.
- Mounts: project read-only at `/project`, input read-only at `/bench/input`,
  expected file folder read-only at `/bench/expected`, and only `/bench/out`
  writable.
- Peak memory is not sampled (the watched process would be the docker CLI),
  so it is reported as "unmeasured in docker".
- Only `cli` supports docker. `validate` rejects a docker study with
  `function` or `agent` candidates, because they would otherwise run outside
  the container (the `agent` adapter also refuses at run time with
  `SANDBOX_UNSUPPORTED`). `http` and `manual` run nothing locally, so the
  sandbox setting does not apply to them.
- `env` values are set in the container. `passEnv` variables are forwarded
  by name only (`--env NAME`), so their values never appear in the
  `docker run` arguments.
- `validate` checks `network`, `memory`, `pids` and `cpus`, and rejects the
  `{workload}` slot in a docker study's `cli` commands.

| Field     | Default  | Meaning                      |
| --------- | -------- | ---------------------------- |
| `image`   | required | Local image name.            |
| `network` | `none`   | `none` or `bridge`.          |
| `memory`  | `2g`     | Passed to `--memory`.        |
| `pids`    | `256`    | Passed to `--pids-limit`.    |
| `cpus`    | not set  | Passed to `--cpus` when set. |

```json
"sandbox": { "type": "docker", "image": "engine-b:local", "network": "none" }
```

## function

Imports one export from a project module and times it inside the worker.
Every candidate implements the same interface: `fn(input, context)`.

| Field         | Required | Meaning                                                                      |
| ------------- | -------- | ---------------------------------------------------------------------------- |
| `module`      | yes      | Path relative to the project, no `..`.                                       |
| `export`      | no       | Export name. Default `default`.                                              |
| `setup`       | no       | Export that prepares the input once, outside the timed loop.                 |
| `inputFormat` | no       | `json`, `text`, `bytes` or `path`. Default: `json` for `.json`, else `path`. |
| `measure`     | no       | `warmup`, `minSamples`, `minTimeMs`, `maxSamples`, `maxTimeMs` (integers).   |

`measure` defaults: `warmup` 2, `minSamples` 10, `minTimeMs` 300,
`maxSamples` 100000, `maxTimeMs` 30000. The loop runs until both the minimum
count and the minimum time are met, bounded by the caps. With `--expose-gc`,
garbage is collected before the loop.

`context` is `{ item, outDir, candidate }`. There are no command slots.

**What it captures.** The first call's return value is saved as the output
(`output.bin` for bytes, `output.txt` for a string, else `output.json`), so
correctness gates check what was timed. Metrics: `wallMs` (median per call),
`wallMsMean`, `cpuMs` (per call), `iterations`, `heapDeltaBytes`,
`peakMemoryBytes` (exact peak of the worker, including the Node runtime) and
`outputBytes`.

**Failure codes.** `MODULE_LOAD`, `FUNCTION_MISSING` (export or setup),
`INPUT_INVALID`.

```json
"adapter": { "type": "function", "module": "src/sorts/radix.mjs", "export": "sort",
             "setup": "prepare", "inputFormat": "json", "measure": { "minSamples": 20 } }
```

## cli

Runs a command per sample, hyperfine-style. `prepare` runs before every
sample and `cleanup` after it. Neither is timed.

| Field       | Required | Meaning                                                          |
| ----------- | -------- | ---------------------------------------------------------------- |
| `command`   | yes      | String or argv array.                                            |
| `prepare`   | no       | Command run before each sample.                                  |
| `cleanup`   | no       | Command run after each sample.                                   |
| `cwd`       | no       | Folder relative to the project. Default the project root.        |
| `outputExt` | no       | Extension for `{out}`, for example `.mp4`. Default none.         |
| `env`       | no       | Variables to set (string values).                                |
| `passEnv`   | no       | Names of host variables to let through the scrubbed environment. |

**Slots** (in `command`, `prepare` and `cleanup`):

| Slot                              | Value                                          |
| --------------------------------- | ---------------------------------------------- |
| `{input}` `{inputDir}`            | The copied workload item and its folder.       |
| `{out}` `{outDir}`                | `out/output<outputExt>` and the `out/` folder. |
| `{expected}`                      | The item's `expectedFile`.                     |
| `{tmp}`                           | The sample's private temp folder.              |
| `{item}` `{candidate}` `{repeat}` | Ids and repeat number.                         |
| `{project}` `{workload}`          | Project root and workload folder.              |

Under docker, paths become container paths (`/bench/input/...`,
`/bench/out/...`, `/tmp`, `/project`). `{workload}` has no value there, so
`validate` rejects it in a docker study.

**What it captures.** `wallMs` (spawn to exit), `peakMemoryBytes` (polled,
labelled "sampled, 50 ms resolution, direct process only"), `outputBytes`
(total size of `out/`), `stdoutBytes`, `exitCode`. The info keeps the exit
code, signal, stdout and stderr tails and paths to the files.

**Failure modes.** A non-zero exit is the candidate's behaviour, not a
harness error. It is recorded and judged by the `exit-code` gate. Harness
problems make the sample errored:

| Code                               | When                                       |
| ---------------------------------- | ------------------------------------------ |
| `COMMAND_NOT_FOUND`                | The program does not exist.                |
| `SPAWN_FAILED`, `ARGV_INVALID`     | The process could not start.               |
| `TIMEOUT`                          | Command or a hook passed the limit.        |
| `PREPARE_FAILED`, `CLEANUP_FAILED` | A hook exited non-zero.                    |
| `SLOT_UNAVAILABLE`                 | A slot has no value for this sample.       |
| `SANDBOX_UNAVAILABLE`              | Docker asked for but missing, or no image. |

```json
"adapter": { "type": "cli", "command": "node scripts/engine-a.mjs --input {input} --out {out}",
             "prepare": "node scripts/clear-cache.mjs", "cleanup": "node scripts/remove-temp.mjs {tmp}" }
```

## http

One request per sample against a service that is already running. The kit
never starts or stops services.

| Field     | Required       | Meaning                                                                              |
| --------- | -------------- | ------------------------------------------------------------------------------------ |
| `baseUrl` | one of the two | An http(s) URL.                                                                      |
| `service` | one of the two | A name looked up in `.gg/bench.config.json` `services`.                              |
| `method`  | no             | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Default `POST` with a body, else `GET`.     |
| `path`    | no             | Starts with `/`. Default `/`. Slots `{item}` `{candidate}` `{repeat}` (URL-encoded). |
| `body`    | no             | `none` (default) or `input` (send the item's input file).                            |
| `headers` | no             | Object of string values.                                                             |

Use `service` to keep machine-specific addresses out of `study.json`:

```json
"services": { "engine-b": "http://127.0.0.1:8080" }
```

**What it captures.** `wallMs` (request start to last body byte), `ttfbMs`,
`outputBytes`, `status`. The body is saved to `out/output.body`. Peak memory
is unmeasured because the service runs outside the kit. The status is
recorded, not judged; use a gate to decide what a bad status means.

**Failure codes.** `SERVICE_UNCONFIGURED`, `INPUT_MISSING` (`body: input`
with no input), `TIMEOUT`, `HTTP_FAILED` (network error), `SLOT_UNAVAILABLE`.

```json
"adapter": { "type": "http", "service": "engine-b", "method": "POST",
             "path": "/render?item={item}", "body": "input",
             "headers": { "content-type": "application/json" } }
```

## agent

Runs a headless coding agent on one task bundle per sample, in a fresh copy
of the bundle's `files/`. Hidden checks (`oracle/`) are never copied into the
workspace. It records the prompt, the event stream, the final message, tool
calls, and what changed (`effects.json`).

Set exactly one of `preset` (`ggcoder` or `claude`) or `command` (any other
agent CLI, with `{prompt}` or `{promptFile}` and a declared `format`). Other
fields: `bin`, `extraArgs` (presets only), `provider`, `model`, `maxTurns`,
`env`, `passEnv`, `pricing`, `watch`. Unknown fields are rejected. API keys
reach the agent only through `passEnv`.

It cannot run under docker (`SANDBOX_UNSUPPORTED`). Other codes include
`TASK_MISSING`, `GIT_UNAVAILABLE`, `SLOT_UNAVAILABLE` and `TIMEOUT`.

```json
"adapter": { "type": "agent", "preset": "ggcoder", "model": "<model>", "maxTurns": 30 }
```

Full details, slots, token and cost metrics: [agent-studies.md](agent-studies.md).

## manual

Numbers measured outside the kit. The file lives in the frozen workload, so
it is hashed into the protocol like any other input.

| Field        | Required | Meaning                                                            |
| ------------ | -------- | ------------------------------------------------------------------ |
| `file`       | yes      | Path inside the workload folder, `.csv` or `.json`.                |
| `format`     | no       | `csv` or `json`. Default from the extension.                       |
| `provenance` | yes      | Who measured these numbers, how and when (at least 10 characters). |

Formats:

```text
CSV:  candidate,item,repeat,<metric>,<metric>...   (an empty cell = not measured)
JSON: [{ "candidate": "engine-b", "item": "clip-4k", "repeat": 0, "values": { "export_seconds": 41.2 } }]
```

**What it captures.** Each value becomes a metric named `reported.<name>`.
Read it with a `custom` metric (`"source": "metric"`). Warm-up slots return
nothing, because manual data has no warm-up.

**Failure codes.** `MANUAL_MISSING` (file unreadable, or no row for this
candidate, item and repeat), `MANUAL_DUPLICATE` (more than one row),
`MANUAL_INVALID` (bad JSON, missing column, non-numeric value). A missing row
is an errored sample, never a silent zero.

```json
"adapter": { "type": "manual", "file": "manual/phone-export.csv",
             "provenance": "Exported on a Pixel 8 by J. Doe, stopwatch app, 2026-10-12" }
```

## How to add an adapter

1. Write `lib/adapters/<name>.mjs` exporting two functions:
   - `validate(config) -> string[]`: one message per problem, `field: reason`.
     Called when `study.json` is checked. Reject unknown slots with
     `validateCommand` from `common.mjs`.
   - `async runSample(job) -> SampleResult`: runs one sample. `job` is the
     `AdapterJob` typedef in `common.mjs` (adapter config, candidate, item,
     phase, repeat, project/study/workload/sample folders, sandbox, config
     services and prices, `timeoutMs`).
2. Return `done(metrics, info)` or `fail(code, message)` from `common.mjs`.
   `done` drops non-finite values, so unmeasured stays unmeasured. Use the
   raw metric names the built-in metrics read (`wallMs`, `cpuMs`,
   `peakMemoryBytes`, `outputBytes`). Put `timing`, `peakMemory.label`,
   `sampleDir`, `outPath`, `outDir` and `stdoutPath` (study-relative) in
   `info` so gates and metrics can find the output.
3. Run external programs through `runProcess` and `scrubEnv` from
   `lib/sandbox/process.mjs`, and build per-sample folders with
   `prepareSample`. Never use a shell.
4. If the adapter cannot honour the study's sandbox, fail every sample with a
   clear code rather than run unsandboxed.
5. Register it in `ADAPTERS` in `lib/adapters/index.mjs` (`validate` plus the
   module path), and add the type name to `ADAPTER_TYPES` in `lib/study.mjs`,
   which rejects any type not in that list.
6. Add tests to `packages/ggcoder/scripts/bench-kit/adapters.test.mjs`:
   validation messages, a completed sample, and each failure code.
