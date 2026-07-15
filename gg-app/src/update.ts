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

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "completed" | "error";

export interface UpdateInfo {
  update: Update | null;
  version: string | null;
  phase: UpdatePhase;
  localPatched: boolean;
  installLabel: string;
  installTitle: string;
  installCommand: string | null;
  statusMessage: string | null;
  progressLines: string[];
  installerPath: string | null;
  install: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PROGRESS_LINES = 8;
const DEV_FAKE_UPDATE = false;
const devFakeEnabled = import.meta.env.DEV && DEV_FAKE_UPDATE;
const LOCAL_UPDATE_COMMAND = "pnpm --filter gg-app update:local-fixes -- --check";
const FAKE_VERSION = "9.9.9";

function appendProgress(lines: string[], line: string): string[] {
  const trimmed = line.trimEnd();
  return trimmed ? [...lines, trimmed].slice(-MAX_PROGRESS_LINES) : lines;
}

function describeLocalProgress(line: string): string | null {
  if (line.includes("git fetch")) return "Fetching upstream source…";
  if (line.includes("git rebase")) return "Rebasing local customizations on upstream…";
  if (line.includes("git stash pop")) return "Restoring your local work…";
  if (line.includes(" gg-app check") || line.includes("@kenkaiiii/ggcoder check")) {
    return "Checking the patched source…";
  }
  if (line.includes("build:local-patched") || line.includes("tauri build")) {
    return "Building a new local-patched installer…";
  }
  if (/conflict|failed/i.test(line)) return line;
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
      setPhase((current) => (current === "installing" ? current : "available"));
      return;
    }
    setPhase((current) => (current === "installing" ? current : "checking"));
    try {
      const found = await check();
      if (found?.available) {
        setUpdate(found);
        setPhase((current) => (current === "installing" ? current : "available"));
        logInfo(`Update available: ${found.version}`);
      } else {
        setUpdate(null);
        setPhase((current) => (current === "installing" ? current : "idle"));
      }
    } catch (error) {
      setPhase((current) => (current === "installing" ? current : "idle"));
      logError(`Update check failed: ${String(error)}`);
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
        setStatusMessage(payload.message ?? "Starting the protected source update…");
      } else if (payload.type === "line" && payload.line) {
        const prefix = payload.stream === "stderr" ? "! " : "";
        setProgressLines((lines) => appendProgress(lines, `${prefix}${payload.line}`));
        const progress = describeLocalProgress(payload.line);
        if (progress) setStatusMessage(progress);
      } else if (payload.type === "completed") {
        setPhase("completed");
        setInstallerPath(payload.installerPath ?? null);
        setStatusMessage(payload.message ?? "Patched installer built.");
      } else if (payload.type === "error") {
        setPhase("error");
        setStatusMessage(payload.message ?? "Local-patched update failed.");
      }
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        setPhase("error");
        setStatusMessage(`Could not listen for update progress: ${String(error)}`);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      setPhase("installing");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return;
    }
    if (appBuildInfo.localPatched) {
      setPhase("installing");
      setProgressLines([]);
      setInstallerPath(null);
      setStatusMessage("Starting local rebase — the official binary will not be installed.");
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
    } catch (error) {
      setPhase("error");
      const kind = appBuildInfo.localPatched ? "Local-patched update" : "Update install";
      setStatusMessage(`${kind} failed: ${String(error)}`);
      logError(`${kind} failed: ${String(error)}`);
    }
  }, [update]);

  const version = update?.version ?? fakeVersion;
  const installLabel = useMemo(() => {
    if (appBuildInfo.localPatched && phase === "installing") return "Building patched installer…";
    if (appBuildInfo.localPatched && phase === "completed") return "Patched installer built";
    if (appBuildInfo.localPatched && phase === "error") return "Local update failed";
    if (appBuildInfo.localPatched) {
      return version ? `Update v${version} (local fixes)` : "Update (local fixes)";
    }
    if (phase === "installing") return "Installing…";
    return version ? `Update to ${version}` : "Update";
  }, [phase, version]);
  const installTitle = appBuildInfo.localPatched
    ? `Runs ${LOCAL_UPDATE_COMMAND} and builds a patched installer without installing the official binary.`
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
    installCommand: appBuildInfo.localPatched ? LOCAL_UPDATE_COMMAND : null,
    statusMessage,
    progressLines,
    installerPath,
    install,
  };
}
