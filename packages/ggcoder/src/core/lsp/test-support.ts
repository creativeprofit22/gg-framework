import fs from "node:fs/promises";

/**
 * Remove a temp directory once the OS lets go of it.
 *
 * `shutdownAll()` signals a language server but does not wait for it to be
 * reaped. POSIX happily unlinks a directory a live process still holds open;
 * Windows refuses with EBUSY/EPERM until every handle is closed. A plain
 * `fs.rm` in `afterEach`/`afterAll` therefore fails LSP suites on Windows in
 * TEARDOWN, with every real assertion already passed — noise that buries the
 * failures worth reading.
 *
 * Retries briefly, then lets a genuine failure surface rather than swallowing
 * it. Test-only helper; not part of the shipped LSP surface.
 */
export async function removeWhenReleased(
  dir: string,
  { attempts = 40, delayMs = 50 } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}
