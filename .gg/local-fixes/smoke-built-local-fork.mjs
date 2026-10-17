import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALLED_SMOKE_IDENTITY,
  INSTALLED_SMOKE_MANIFEST_NAME,
} from "../../gg-app/scripts/build-local-hotfix.mjs";
import {
  fileMetadata,
  runInstalledSmokePreflight,
  validateInstalledSmokeManifest,
} from "../../gg-app/scripts/installed-smoke-preflight.mjs";
import {
  assertInstalledSmokeRegistration,
  smokeRevisionExpectations,
} from "../../gg-app/scripts/smoke-built-local-fork.mjs";
import {
  connectToDevWebview,
  createIsolatedProfile,
  finalizeSmokeLifecycle,
  reserveHeldTcpPort,
} from "../../gg-app/scripts/phase-25-windows-smoke-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedHead = "8b86b3694c88b0bcfa796f726c6e71146e09822a";
const localForkIdentifier = "com.ggcoder.local-fork";
const installedSmokeUninstallKey =
  `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALLED_SMOKE_IDENTITY.productName}`;

const packagedInstaller = resolve(
  repoRoot,
  "gg-app",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  "GG Coder Local Fork_0.55.3_x64-setup.exe",
);
const installedSmokeManifestPath = resolve(
  repoRoot,
  ".gg",
  "local-fixes",
  INSTALLED_SMOKE_MANIFEST_NAME,
);

function powershell(script, env = process.env) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", env, windowsHide: true },
  ).trim();
}

function inspectLocalForkPaths() {
  const output = powershell(
    `$active = @(Get-CimInstance Win32_Process -Filter "Name = 'gg-coder-local-fork.exe'" ` +
      `| Where-Object ExecutablePath | ForEach-Object ExecutablePath); ` +
      `$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GG Coder Local Fork'; ` +
      `$registered = @(); if (Test-Path $key) { $registered = @((Get-ItemProperty $key).InstallLocation) }; ` +
      `[pscustomobject]@{ activeExecutablePaths = $active; registeredInstallPaths = $registered } ` +
      `| ConvertTo-Json -Compress`,
  );
  const parsed = JSON.parse(output);
  const array = (value) =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((path) => String(path).trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  return {
    activeExecutablePaths: array(parsed.activeExecutablePaths),
    registeredInstallPaths: array(parsed.registeredInstallPaths),
  };
}

function readInstalledSmokeRegistration() {
  const output = powershell(
    `$key = '${installedSmokeUninstallKey}'; ` +
      `if (Test-Path -LiteralPath $key) { ` +
      `Get-ItemProperty -LiteralPath $key | Select-Object InstallLocation,UninstallString ` +
      `| ConvertTo-Json -Compress }`,
  );
  return output ? JSON.parse(output) : null;
}

function processPath(pid) {
  const output = powershell(
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.Path }; exit 0`,
  );
  return output ? resolve(output) : null;
}

function descendants(pid) {
  const output = powershell(
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; ` +
      `$pending = [System.Collections.Generic.Queue[uint32]]::new(); $pending.Enqueue(${pid}); ` +
      `$seen = [System.Collections.Generic.HashSet[uint32]]::new(); ` +
      `while ($pending.Count -gt 0) { $parent = $pending.Dequeue(); ` +
      `foreach ($child in $all | Where-Object ParentProcessId -eq $parent) { ` +
      `if ($seen.Add([uint32]$child.ProcessId)) { $pending.Enqueue([uint32]$child.ProcessId) } } }; ` +
      `$seen | ConvertTo-Json -Compress`,
  );
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
}

async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function terminateExactTree(pid, expectedPath) {
  const currentPath = processPath(pid);
  if (!currentPath) return;
  if (currentPath.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new Error(`Refusing fallback cleanup for reused PID ${pid}: ${currentPath}`);
  }
  execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function smokeKindFromArgs(args) {
  const smokeKind = args[0] ?? "packaged";
  if (args.length > 1 || (smokeKind !== "packaged" && smokeKind !== "installed")) {
    throw new Error("Smoke kind must be packaged or installed");
  }
  return smokeKind;
}


async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32") throw new Error("Windows is required");
  const smokeKind = smokeKindFromArgs(args);
  const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const installedManifest =
    smokeKind === "installed"
      ? validateInstalledSmokeManifest(installedSmokeManifestPath, {
          expectedRevision: localHead,
        })
      : null;
  const expectedSourceRevision = installedManifest?.sourceRevision ?? expectedHead;
  if (localHead !== expectedSourceRevision) {
    throw new Error(`Unexpected source HEAD: ${localHead}`);
  }
  const { expectedIdentity, shortRevision } = smokeRevisionExpectations(expectedSourceRevision);
  const installer = installedManifest?.path ?? packagedInstaller;
  const identifier = installedManifest?.identity.identifier ?? localForkIdentifier;
  const executableName =
    installedManifest?.identity.executableName ??
    (process.platform === "win32" ? "gg-coder-local-fork.exe" : "gg-coder-local-fork");
  if (!existsSync(installer)) throw new Error(`Built installer is missing: ${installer}`);

  const screenshot = resolve(
    repoRoot,
    ".gg",
    "screenshots",
    `roadmap-reliability-${smokeKind}-${shortRevision}.png`,
  );
  const profileRoot = mkdtempSync(join(tmpdir(), "gg-app-local-fork-smoke-"));
  const stageRoot = join(profileRoot, "staged-payload");
  const executable = join(stageRoot, executableName);
  const uninstaller = join(stageRoot, "uninstall.exe");
  const paths = createIsolatedProfile(profileRoot);
  const identityRoot = join(paths.home, ".gg", "identities", identifier);
  let portReservation = null;
  let portReleased = false;
  let appPid = null;
  let client = null;
  let installedUninstaller = null;
  let identity = null;
  let primaryError = null;

  try {
    if (smokeKind === "packaged") {
      execFileSync("7z", ["x", "-y", `-o${stageRoot}`, installer], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      mkdirSync(stageRoot, { recursive: true });
      runInstalledSmokePreflight({
        manifestPath: installedSmokeManifestPath,
        stageRoot,
        inspectSystemPaths: inspectLocalForkPaths,
        validationOptions: { expectedRevision: localHead },
        execute(manifest) {
          try {
            execFileSync(manifest.path, ["/S", `/D=${stageRoot}`], {
              stdio: "ignore",
              windowsHide: true,
            });
          } finally {
            if (existsSync(uninstaller)) installedUninstaller = uninstaller;
          }
        },
      });
      if (!installedUninstaller) throw new Error(`Uninstaller is missing: ${uninstaller}`);
      assertInstalledSmokeRegistration(readInstalledSmokeRegistration(), stageRoot);
    }
    if (!existsSync(executable)) throw new Error(`Staged binary is missing: ${executable}`);
    if (installedManifest) {
      const actualPayload = fileMetadata(executable);
      if (
        actualPayload.size !== installedManifest.payload.size ||
        actualPayload.sha256 !== installedManifest.payload.sha256
      ) {
        throw new Error("Installed Smoke staged payload size or SHA-256 mismatch.");
      }
    }
    portReservation = await reserveHeldTcpPort();

    mkdirSync(identityRoot, { recursive: true });
    writeFileSync(join(identityRoot, "auth.json"), '{"anthropic":{}}\n');
    writeFileSync(
      join(identityRoot, "gg-app.json"),
      `${JSON.stringify({ projectsRoot: paths.root }, null, 2)}\n`,
    );
    writeFileSync(
      join(identityRoot, "gg-app-workspace.json"),
      `${JSON.stringify(
        {
          windows: [
            {
              mode: "code",
              cwd: paths.project,
              sessionPath: null,
              width: 1024,
              height: 720,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const requiredEnvironment = [
      "ALLUSERSPROFILE",
      "ComSpec",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "PATH",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_IDENTIFIER",
      "ProgramData",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "SystemDrive",
      "SystemRoot",
      "WINDIR",
    ];
    const environment = Object.fromEntries(
      requiredEnvironment.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    Object.assign(environment, {
      HOME: paths.home,
      USERPROFILE: paths.home,
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      TEMP: paths.temp,
      TMP: paths.temp,
      WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${portReservation.port}`,
      GG_APP_CWD: paths.project,
      GG_SMOKE_EXE: executable,
      GG_SMOKE_CWD: dirname(executable),
    });
    await portReservation.release();
    portReleased = true;
    appPid = Number(
      powershell(
        `$p = Start-Process -FilePath $env:GG_SMOKE_EXE -WorkingDirectory $env:GG_SMOKE_CWD ` +
          `-WindowStyle Minimized -PassThru; $p.Id`,
        environment,
      ),
    );
    if (!Number.isInteger(appPid) || appPid < 1) throw new Error(`Invalid app PID: ${appPid}`);
    await waitFor("exact built process", () => {
      const current = processPath(appPid);
      return (
        current && realpathSync(current).toLowerCase() === realpathSync(executable).toLowerCase()
      );
    });
    await waitFor(
      "minimized app window",
      () => {
        const output = powershell(
          `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Native { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'; ` +
            `$p = Get-Process -Id ${appPid} -ErrorAction Stop; if ($p.MainWindowHandle -ne 0) { ` +
            `[Native]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null; Start-Sleep -Milliseconds 100; ` +
            `if ([Native]::IsIconic($p.MainWindowHandle)) { "yes" } }`,
        );
        return output === "yes";
      },
      30_000,
    );

    client = await connectToDevWebview(portReservation.port, waitFor);
    const pageState = await waitFor("rendered app body", async () => {
      const state = await client.evaluate(`({
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText ?? ''
    })`);
      return state.bodyText ? state : null;
    });
    console.log(JSON.stringify({ pageState }, null, 2));
    identity = await client.evaluate(
      `document.querySelector('.footer-custom-build')?.textContent ?? null`,
    );
    if (!identity) {
      await waitFor("ready Code action", () =>
        client.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === 'Code'
        );
        return Boolean(button && button.getAttribute('aria-disabled') !== 'true');
      })()`),
      );
      await client.evaluate(`
      [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Code'
      )?.click()
    `);
      await waitFor(
        "discovered smoke project",
        () => client.evaluate(`document.querySelector('.picker-item') !== null`),
        30_000,
      );
      await client.evaluate(`document.querySelector('.picker-item')?.click()`);
      await waitFor("new smoke session action", () =>
        client.evaluate(`
        [...document.querySelectorAll('button')].some(
          (candidate) => candidate.textContent?.trim() === '+ New session'
        )
      `),
      );
      await client.evaluate(`
      [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === '+ New session'
      )?.click()
    `);
      identity = await waitFor("local-patched footer identity", () =>
        client.evaluate(`document.querySelector('.footer-custom-build')?.textContent ?? null`),
      );
    }
    if (identity !== expectedIdentity) throw new Error(`Unexpected build identity: ${identity}`);

    const sidecarLog = await waitFor("sidecar log", () => {
      const name = readdirSync(identityRoot).find((entry) => entry.endsWith("-sidecar.log"));
      return name ? join(identityRoot, name) : null;
    });
    await waitFor("bundled sidecar readiness", () => {
      if (!existsSync(sidecarLog)) return false;
      return readFileSync(sidecarLog, "utf8").includes("daemon listening");
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
    const footerState = await client.evaluate(`({
    updateBannerCount: document.querySelectorAll('.update-banner').length,
    bodyText: document.body?.innerText ?? ''
  })`);
    if (
      footerState.updateBannerCount !== 0 ||
      /just updated|click to review/i.test(footerState.bodyText)
    ) {
      throw new Error(`Automatic update footer is visible: ${JSON.stringify(footerState)}`);
    }

    mkdirSync(dirname(screenshot), { recursive: true });
    const capture = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
  } catch (error) {
    primaryError = error;
  }

  const cleanup = await finalizeSmokeLifecycle(
    {
      client,
      appPid,
      executable,
      installedUninstaller,
      releasePort:
        portReservation && !portReleased ? () => portReservation.release() : null,
    },
    {
      closeClient: (activeClient) => activeClient.close(),
      async terminateProcessTree(pid, expectedExecutable) {
        const processIds = [pid, ...descendants(pid)];
        terminateExactTree(pid, expectedExecutable);
        await waitFor(
          "smoke process-tree cleanup",
          () => processIds.every((processId) => processPath(processId) === null),
          30_000,
        );
      },
      uninstall(candidate) {
        if (resolve(candidate).toLowerCase() !== resolve(uninstaller).toLowerCase()) {
          throw new Error(`Refusing unexpected uninstaller: ${candidate}`);
        }
        execFileSync(candidate, ["/S"], { stdio: "ignore", windowsHide: true });
      },
      waitForInstalledRemoval: () =>
        waitFor(
          "Installed Smoke payload and registration removal",
          () => !existsSync(executable) && !readInstalledSmokeRegistration(),
          30_000,
        ),
    },
    primaryError,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        smokeKind,
        installer,
        executable,
        identity,
        minimized: true,
        sidecarReady: true,
        automaticUpdateFooter: false,
        screenshot,
        isolatedProfile: profileRoot,
        ...cleanup,
      },
      null,
      2,
    )}\n`,
  );
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
