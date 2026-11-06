import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface IsolatedProfile {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
  webview2: string;
  project: string;
  audit: string;
  screenshots: string;
}

export function createIsolatedProfile(
  root: string,
  projectDir: string = join(root, "project"),
): IsolatedProfile {
  const home = join(root, "home");
  const paths: IsolatedProfile = {
    root,
    home,
    appData: join(home, "AppData", "Roaming"),
    localAppData: join(home, "AppData", "Local"),
    temp: join(root, "temp"),
    webview2: join(root, "webview2"),
    project: projectDir,
    audit: join(root, "audit"),
    screenshots: join(root, "screenshots"),
  };
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  return paths;
}

export type SmokeEnvironment = Record<string, string>;

export function sanitizedSmokeEnvironment(
  baseEnvironment: Record<string, string | undefined>,
  paths: IsolatedProfile,
  fixtureVariables: Record<string, string> = {},
): SmokeEnvironment {
  const environment: SmokeEnvironment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (/^(GG_|TAURI_|WEBVIEW2_)/i.test(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
    GG_APP_CWD: paths.project,
    ...fixtureVariables,
  };
}

export type DevAppWindow = "minimized" | "visible";

export interface DevAppEnvironmentOptions {
  cdpPort: number;
  window?: DevAppWindow;
  extra?: Record<string, string>;
}

/** Exactly the switches the debug-only gate in src-tauri/src/windows.rs reads. */
export function devAppEnvironment(
  baseEnvironment: Record<string, string | undefined>,
  paths: IsolatedProfile,
  { cdpPort, window = "minimized", extra = {} }: DevAppEnvironmentOptions,
): SmokeEnvironment {
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
    throw new RangeError(`invalid control port: ${cdpPort}`);
  }
  if (window !== "minimized" && window !== "visible") {
    throw new RangeError("window must be 'minimized' or 'visible'");
  }
  return sanitizedSmokeEnvironment(baseEnvironment, paths, {
    ...extra,
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_APP_DEV_SMOKE_WINDOW: window,
    WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
  });
}
