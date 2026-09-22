import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';

function quote(value) {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Invalid isolation path');
  return JSON.stringify(realpathSync(value));
}

/** macOS worker boundary. Other platforms fail closed until an equivalent is verified. */
export function workerProfile({ workspace, home, readRoots, brokerPort, forbiddenRoots }) {
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) throw new Error('Invalid broker port');
  const roots = [workspace, home, ...readRoots].map((root) => realpathSync(root));
  for (const root of roots) {
    for (const forbidden of forbiddenRoots) {
      const rel = relative(root, realpathSync(forbidden));
      if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
        throw new Error('Read root would expose private files');
      }
    }
  }
  return `(version 1)
(deny default)
(allow process-exec process-fork signal sysctl-read mach-lookup)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library/Apple") (subpath "/dev") (literal "/private/etc/localtime"))
${roots.map((root) => `(allow file-read* (subpath ${quote(root)}))`).join('\n')}
(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(home)}) (literal "/dev/null"))
${forbiddenRoots.map((root) => `(deny file-read* file-write* (subpath ${quote(root)}))`).join('\n')}
(allow network-outbound (remote ip "localhost:${brokerPort}") (remote tcp "*:443"))`;
}

export function spawnIsolatedWorker({ entry, workspace, home, readRoots, brokerPort, forbiddenRoots, token, timeoutMs = 600000 }) {
  if (process.platform !== 'darwin') throw new Error('Worker isolation not verified on this platform; paid runs disabled');
  const profile = workerProfile({ workspace, home, readRoots, brokerPort, forbiddenRoots });
  // Deliberately do not inherit provider keys, user PATH, NODE_OPTIONS or proxy settings.
  return spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, entry], {
    cwd: workspace,
    env: { HOME: home, GG_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', GG_TEST_BROKER_PORT: String(brokerPort), GG_TEST_BROKER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}
