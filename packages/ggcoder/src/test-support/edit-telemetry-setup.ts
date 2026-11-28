import os from "node:os";
import path from "node:path";

// Runs in each worker after the run-temp global setup, so os.tmpdir() is this
// run's ggt-* folder and the telemetry file is deleted with it.
process.env.GG_EDIT_TELEMETRY_PATH ??= path.join(os.tmpdir(), "gg-vitest-edit-quality.jsonl");
