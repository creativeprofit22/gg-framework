/**
 * Body for a test fixture process that must stay running until a test kills
 * it, yet must not outlive the test run itself.
 *
 * A bare `setInterval(() => {}, 1000)` runs forever: if the test runner is
 * killed mid-test (Ctrl+C, an agent's timeout, a crashed worker), cleanup in
 * `finally`/`afterEach` never runs and the fixture is orphaned for good. This
 * one exits as soon as the owning test process is gone, which never changes
 * a test's outcome because the owner is alive for the whole test.
 *
 * Contains no quotes, `$` or backslashes, so it can be embedded in a
 * double-quoted shell argument or a JS string literal unchanged.
 */
export function keepAliveWhileOwnerLives(ownerPid: number = process.pid): string {
  return `setInterval(()=>{try{process.kill(${ownerPid},0)}catch{process.exit(0)}},1000);`;
}
