import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { VerifyPlanStatus } from "@kenkaiiii/gg-core/verify-plan";
import type { PaneAgentClient } from "./agent";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { GlassLamp } from "./GlassLamp";

type VerifyPlanClient = Pick<PaneAgentClient, "getVerifyPlanStatus" | "approveVerifyPlan">;

const PLAIN_ARG = /^[^\s"'\\]+$/;

/** Show argv exactly: arguments with spaces, quotes or backslashes are JSON-quoted. */
export function formatVerifyPlanArgv(argv: readonly string[]): string {
  return argv.map((arg) => (PLAIN_ARG.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

/**
 * Asks before running the project's own check command (`.gg/verify-plan.json`),
 * in the Opportunities panel's shell. Nothing runs until Allow; a changed
 * command asks again. When an allowed command doesn't work, says so.
 */
export function VerifyPlanNotice({
  client,
  refreshKey,
}: {
  client: VerifyPlanClient;
  /** Bump to re-read the status (e.g. after a run ends). */
  refreshKey: number;
}): React.ReactElement | null {
  const [status, setStatus] = useState<VerifyPlanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const fetchRef = useRef(0);
  const headingId = useId();
  const { getVerifyPlanStatus, approveVerifyPlan } = client;

  useEffect(() => {
    if (!getVerifyPlanStatus) return;
    const fetchId = ++fetchRef.current;
    void getVerifyPlanStatus().then((next) => {
      if (fetchId === fetchRef.current) setStatus(next);
    });
  }, [getVerifyPlanStatus, refreshKey]);
  useEffect(
    () => () => {
      fetchRef.current++;
    },
    [],
  );

  const allow = useCallback(async () => {
    if (status?.state !== "needs-approval" || !approveVerifyPlan) return;
    const fetchId = ++fetchRef.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await approveVerifyPlan(status.descriptorSha256);
      if (fetchId !== fetchRef.current) return;
      setStatus(result.status);
      if (!result.ok)
        setMessage(
          result.reason === "changed"
            ? "The command changed after you saw it, so nothing ran. Check the new command below."
            : "This project no longer has a check command, so nothing ran.",
        );
    } catch (error) {
      if (fetchId === fetchRef.current)
        setMessage(
          `Couldn't save your choice: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (fetchId === fetchRef.current) setBusy(false);
    }
  }, [approveVerifyPlan, status]);

  if (status === null) return null;
  const notice = message && (
    <p className="opp-notice" data-tone="warning" role="alert">
      {message}
    </p>
  );

  if (status.state === "needs-approval") {
    if (dismissed === status.descriptorSha256) return null;
    return (
      <section className="programmatic-chat instrument" aria-labelledby={headingId}>
        <header className="opp-head">
          <GlassLamp active={busy} />
          <div className="opp-head-text">
            <h2 id={headingId}>Allow this project's check command?</h2>
            <p className="opp-meta">Not run yet · Asks again if it changes</p>
          </div>
        </header>
        <p>
          This project wants to run the command below on your computer before each task, so{" "}
          {PRODUCT_DISPLAY_NAME} knows which checks to run.
        </p>
        <pre aria-label="Command">{formatVerifyPlanArgv(status.argv)}</pre>
        <p>
          Runs in <code>{status.cwd}</code>
        </p>
        {notice}
        <div className="programmatic-actions">
          <button
            type="button"
            className="inst-key"
            onClick={() => void allow()}
            disabled={busy || !approveVerifyPlan}
          >
            {busy ? "Allowing…" : "Allow"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDismissed(status.descriptorSha256)}
            disabled={busy}
          >
            Don't allow
          </button>
        </div>
      </section>
    );
  }

  if (status.state === "heuristics" && status.descriptorPresent) {
    if (dismissed === status.reason) return null;
    return (
      <section className="programmatic-chat instrument" aria-labelledby={headingId}>
        <header className="opp-head">
          <GlassLamp />
          <div className="opp-head-text">
            <h2 id={headingId}>Project check command not used</h2>
            <p className="opp-meta">Using built-in checks</p>
          </div>
        </header>
        <p role="status">
          This project's check command didn't work, so {PRODUCT_DISPLAY_NAME} is using its built-in
          checks instead.
        </p>
        <details>
          <summary>Details</summary>
          <pre>{status.reason}</pre>
        </details>
        {notice}
        <div className="programmatic-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDismissed(status.reason)}
          >
            Dismiss
          </button>
        </div>
      </section>
    );
  }
  return null;
}
