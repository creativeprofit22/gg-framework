import { useCallback, useEffect, useMemo, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import {
  listenLocalPatchedUpdate,
  startLocalPatchedUpdate,
  type LocalPatchedUpdateEvent,
} from "./agent";
import { appBuildInfo } from "./build-info";
import { installUpdateForBuild } from "./update-policy";

/**
 * App self-update, driven by the Tauri updater plugin (GitHub releases of this
 * repo — see `plugins.updater` in tauri.conf.json). One shared hook powers both
 * the footer banner and the home-screen button: it polls for an update on mount
 * + hourly, and `install()` downloads → installs → relaunches the app. Local-patched
 * builds still check for official updates, but block direct official binary installs;
 * their install action rebases the local branch on upstream, reapplies work,
 * and builds a new patched installer.
 */

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "completed" | "error";

export interface UpdateInfo {
  /** The pending update (null until one is detected). */
  update: Update | null;
  /** Newer version string, e.g. "0.2.0" (null when up to date). */
  version: string | null;
  phase: UpdatePhase;
  /** True for locally rebuilt app bundles that must preserve source fixes. */
  localPatched: boolean;
  /** Label suitable for an update button. */
  installLabel: string;
  /** Tooltip/title explaining what the install action does. */
  installTitle: string;
  /** Safe local-branch rebase workflow command for local-patched builds. */
  installCommand: string | null;
  /** User-facing status for rebase/build progress/errors/completion. */
  statusMessage: string | null;
  /** Recent streamed lines from the local rebase/build workflow. */
  progressLines: string[];
  /** Rebuilt installer, when the local-patched workflow reports one. */
  installerPath: string | null;
  /** Kick off download → install → relaunch, or the local-patched source workflow. */
  install: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PROGRESS_LINES = 8;

/**
 * DEV ONLY — fake a pending update so the banner + home button + install flow
 * can be eyeballed before any real GitHub release exists. Flip to `false` (or
 * just ship a production build, where it's ignored) to disable. The simulated
 * install runs the phases without downloading or relaunching.
 */
const DEV_FAKE_UPDATE = false;
const devFakeEnabled = import.meta.env.DEV && DEV_FAKE_UPDATE;
const LOCAL_UPDATE_COMMAND = "pnpm --filter gg-app update:local-fixes -- --check";
const FAKE_VERSION = "9.9.9";

function appendProgress(lines: string[], line: string): string[] {
  const trimmed = line.trimEnd();
  if (!trimmed) return lines;
  return [...lines, trimmed].slice(-MAX_PROGRESS_LINES);
}

function describeLocalProgress(line: string): string | null {
  if (line.includes("git fetch")) return "Fetching upstream source…";
  if (line.includes("git rebase")) return "Rebasing local customizations on upstream…";
  if (line.includes("git stash pop")) return "Reapplying your local work…";
  if (line.includes(" gg-app check") || line.includes("@kenkaiiii/ggcoder check")) {
    return "Checking the patched source…";
  }
  if (line.includes("build:local-patched") || line.includes("tauri build")) {
    return "Building a new local-patched installer…";
  }
  if (line.includes("conflict") || line.includes("failed") || line.includes("Failed")) {
    return line;
  }
  return null;
}

export function useAppUpdate(): UpdateInfo {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [fakeVersion, setFakeVersion] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [installerPath, setInstallerPath] = useState<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      setFakeVersion(FAKE_VERSION);
      setPhase((p) => (p === "installing" ? p : "available"));
      return;
    }
    // Don't interrupt an in-flight install with a re-check.
    setPhase((p) => (p === "installing" ? p : "checking"));
    try {
      const found = await check();
      if (found?.available) {
        setUpdate(found);
        setPhase((p) => (p === "installing" ? p : "available"));
        logInfo(`Update available: ${found.version}`);
      } else {
        setUpdate(null);
        setPhase((p) => (p === "installing" ? p : "idle"));
      }
    } catch (e) {
      // No endpoint / no release yet / offline — stay quiet, just no banner.
      setPhase((p) => (p === "installing" ? p : "idle"));
      logError(`Update check failed: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void runCheck();
    const id = setInterval(() => void runCheck(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runCheck]);

  useEffect(() => {
    if (!appBuildInfo.localPatched) return undefined;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenLocalPatchedUpdate((payload: LocalPatchedUpdateEvent) => {
      if (cancelled) return;
      if (payload.type === "started") {
        setPhase("installing");
        setInstallerPath(null);
        setProgressLines([]);
        setStatusMessage(
          payload.message ??
            "Rebasing local branch on upstream, reapplying work, checking, then building a patched installer…",
        );
        return;
      }
      if (payload.type === "line" && payload.line) {
        const prefix = payload.stream === "stderr" ? "! " : "";
        setProgressLines((lines) => appendProgress(lines, `${prefix}${payload.line ?? ""}`));
        const progress = describeLocalProgress(payload.line);
        if (progress) setStatusMessage(progress);
        return;
      }
      if (payload.type === "completed") {
        setPhase("completed");
        setInstallerPath(payload.installerPath ?? null);
        setStatusMessage(payload.message ?? "Patched installer built.");
        return;
      }
      if (payload.type === "error") {
        setPhase("error");
        setStatusMessage(payload.message ?? "Local-patched update failed.");
      }
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((e) => {
        setPhase("error");
        setStatusMessage(`Could not listen for local-patched update progress: ${String(e)}`);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      // Simulate download/install without touching disk or relaunching.
      setPhase("installing");
      logInfo("[dev] Simulating update install…");
      await new Promise((r) => setTimeout(r, 2500));
      logInfo("[dev] Fake install done (no relaunch in dev).");
      return;
    }
    if (appBuildInfo.localPatched) {
      setPhase("installing");
      setProgressLines([]);
      setInstallerPath(null);
      setStatusMessage("Starting local rebase — this will not install the official binary.");
      logInfo(
        `Local-patched build detected. Running ${LOCAL_UPDATE_COMMAND} to rebase local branch on upstream, reapply work, and build a patched installer.`,
      );
    } else if (update) {
      setPhase("installing");
    }

    try {
      await installUpdateForBuild({
        localPatched: appBuildInfo.localPatched,
        sourceRoot: appBuildInfo.sourceRoot,
        update,
        startLocalPatchedUpdate,
        relaunch,
      });
    } catch (e) {
      setPhase("error");
      if (appBuildInfo.localPatched) {
        setStatusMessage(`Could not start local-patched update: ${String(e)}`);
        logError(`Local-patched update start failed: ${String(e)}`);
      } else {
        setStatusMessage(`Update install failed: ${String(e)}`);
        logError(`Update install failed: ${String(e)}`);
      }
    }
  }, [update]);

  const version = update?.version ?? fakeVersion;
  const installCommand = appBuildInfo.localPatched ? LOCAL_UPDATE_COMMAND : null;
  const installLabel = useMemo(() => {
    if (appBuildInfo.localPatched && phase === "installing") return "Building patched installer…";
    if (appBuildInfo.localPatched && phase === "completed") return "Patched installer built";
    if (appBuildInfo.localPatched && phase === "error") return "Local update failed";
    if (appBuildInfo.localPatched)
      return version ? `Update v${version} (local fixes)` : "Update (local fixes)";
    if (phase === "installing") return "Installing…";
    return version ? `Update to ${version}` : "Update";
  }, [phase, version]);
  const installTitle = appBuildInfo.localPatched
    ? `Runs ${LOCAL_UPDATE_COMMAND}: rebases the local branch on upstream, reapplies work, checks, and builds a patched installer instead of installing the official binary.`
    : version
      ? `Update to ${version} — installs and restarts the app`
      : "Install update and restart the app";

  return {
    update,
    version,
    phase,
    localPatched: appBuildInfo.localPatched,
    installLabel,
    installTitle,
    installCommand,
    statusMessage,
    progressLines,
    installerPath,
    install,
  };
}
