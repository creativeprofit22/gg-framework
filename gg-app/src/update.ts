import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import {
  checkLocalPatchedUpdate,
  listenLocalPatchedUpdate,
  startLocalPatchedUpdate,
  type LocalPatchedUpdateEvent,
} from "./agent";
import type { SafeTauriUnlisten } from "./tauri-listener";
import { appBuildInfo } from "./build-info";
import { installUpdateForBuild } from "./update-policy";

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "completed" | "error";

export interface UpdateInfo {
  update: Update | null;
  version: string | null;
  phase: UpdatePhase;
  /** Official download progress 0–100 while installing (null otherwise). */
  progress: number | null;
  localPatched: boolean;
  installLabel: string;
  installTitle: string;
  installCommand: string | null;
  statusMessage: string | null;
  progressLines: string[];
  installerPath: string | null;
  install: (options?: { summarizeDecisions?: boolean }) => Promise<void>;
}

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PROGRESS_LINES = 8;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Registration can fail before install is requested; the effect owns the UI error.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Development-only fake update flow. */
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
  if (line.includes("git merge")) return "Merging upstream into local customizations…";
  if (line.includes("git stash apply")) return "Restoring your local work…";
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
  const [progress, setProgress] = useState<number | null>(null);
  const [fakeVersion, setFakeVersion] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const localListenerReady = useRef<Deferred | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    // Local Fork builds use the reviewed source-merge flow and must never contact
    // the production updater endpoint.
    if (appBuildInfo.localPatched) {
      setUpdate(null);
      setPhase((current) =>
        current === "installing" || current === "completed" ? current : "checking",
      );
      try {
        const status = await checkLocalPatchedUpdate(
          appBuildInfo.sourceRoot ?? "",
          appBuildInfo.sourceRevision,
        );
        logInfo(`Local update status: ${status.origin}`);
        setPhase((current) =>
          current === "installing" || current === "completed"
            ? current
            : status.available
              ? "available"
              : "idle",
        );
      } catch (error) {
        setPhase((current) =>
          current === "installing" || current === "completed" ? current : "idle",
        );
        logError(`Local update check failed: ${String(error)}`);
      }
      return;
    }
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
    const listenerReady = createDeferred();
    localListenerReady.current = listenerReady;
    let cancelled = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void listenLocalPatchedUpdate((payload: LocalPatchedUpdateEvent) => {
      if (cancelled) return;
      if (payload.type === "started") {
        setPhase("installing");
        setInstallerPath(null);
        setProgressLines([]);
        setStatusMessage("Starting protected source merge…");
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
        if (cancelled) void cleanup();
        else {
          unlisten = cleanup;
          listenerReady.resolve();
        }
      })
      .catch((error) => {
        if (cancelled) return;
        listenerReady.reject(error);
        setPhase("error");
        setStatusMessage(`Could not listen for update progress: ${String(error)}`);
      });
    return () => {
      cancelled = true;
      if (localListenerReady.current === listenerReady) localListenerReady.current = null;
      void unlisten?.();
    };
  }, []);

  const install = useCallback(
    async ({
      summarizeDecisions = false,
    }: { summarizeDecisions?: boolean } = {}): Promise<void> => {
      if (devFakeEnabled) {
        setPhase("installing");
        setProgress(0);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        setProgress(null);
        setPhase("available");
        return;
      }
      if (appBuildInfo.localPatched) {
        setPhase("installing");
        setProgressLines([]);
        setInstallerPath(null);
        setStatusMessage(
          "Starting protected local merge — the official binary will not be installed.",
        );
        try {
          await localListenerReady.current?.promise;
        } catch (error) {
          setPhase("error");
          setStatusMessage(`Could not listen for update progress: ${String(error)}`);
          return;
        }
        try {
          await installUpdateForBuild({
            localPatched: true,
            sourceRoot: appBuildInfo.sourceRoot,
            update: null,
            summarizeDecisions,
            startLocalPatchedUpdate,
            relaunch,
          });
        } catch (error) {
          setPhase("error");
          setStatusMessage(`Local-patched update failed: ${String(error)}`);
          logError(`Local-patched update failed: ${String(error)}`);
        }
        return;
      }
      if (!update) return;
      setPhase("installing");
      setProgress(0);
      try {
        let total = 0;
        let downloaded = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            if (total > 0) setProgress(Math.min(99, Math.round((downloaded / total) * 100)));
          } else setProgress(100);
        });
        await relaunch();
      } catch (error) {
        setPhase("error");
        setProgress(null);
        setStatusMessage(`Update install failed: ${String(error)}`);
        logError(`Update install failed: ${String(error)}`);
      }
    },
    [update],
  );

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
    progress,
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
