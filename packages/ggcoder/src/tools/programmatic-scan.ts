import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "../core/programmatic/lifecycle.js";
import { containedPath, stableJson } from "../core/tauri-package/paths.js";
import { isPlanModeActive } from "../core/runtime-mode.js";

export const ProgrammaticScanParams = z.strictObject({});

export interface ProgrammaticScanToolOptions {
  localFilesystem?: boolean;
  planModeRef?: { current: boolean };
  onPreFileMutation?: (absolutePath: string) => Promise<void> | void;
  onFileMutated?: (absolutePath: string) => Promise<void> | void;
}

const failedSummary = {
  new: 0,
  unchanged: 0,
  active: 0,
  completed: 0,
  dismissed: 0,
  disappeared: 0,
  failed: 1,
  unverified: 0,
} as const;

function unavailable(code: "local-filesystem-required" | "plan-mode-read-only"): string {
  return stableJson({
    ok: false,
    changed: false,
    recovered: false,
    state_path: PROGRAMMATIC_STATE_PATH,
    configuration_fingerprint: null,
    summary: failedSummary,
    error: { code, detail: "The programmatic scan cannot persist lifecycle state in this mode." },
  });
}

export function createProgrammaticScanTool(
  cwd: string,
  options: ProgrammaticScanToolOptions = {},
): AgentTool<typeof ProgrammaticScanParams> {
  return {
    name: "programmatic_scan",
    description:
      "Run the approved fixed-profile programmatic scanner once, reconcile lifecycle state, and return bounded summary counts. Accepts no paths, commands, scanners, opportunities, or lifecycle actions.",
    parameters: ProgrammaticScanParams,
    executionMode: "sequential",
    async execute() {
      if (options.localFilesystem === false) return unavailable("local-filesystem-required");
      if (isPlanModeActive(options.planModeRef)) return unavailable("plan-mode-read-only");

      const result = await runProgrammaticScan(cwd, {
        onPreFileMutation: (repositoryPath) =>
          options.onPreFileMutation?.(containedPath(cwd, repositoryPath)),
        onFileMutated: (repositoryPath) =>
          options.onFileMutated?.(containedPath(cwd, repositoryPath)),
      });
      return stableJson({
        ok: result.ok,
        changed: result.changed,
        recovered: result.recovered,
        state_path: result.path,
        configuration_fingerprint: result.configurationFingerprint,
        summary: result.summary,
        ...(result.ok ? {} : { error: { code: result.error, detail: result.detail } }),
      });
    },
  };
}
