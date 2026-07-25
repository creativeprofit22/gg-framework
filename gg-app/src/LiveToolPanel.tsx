import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import type { BashDiagnostics, BashToolResultDetails, TaskOutputDetails } from "./agent";
import { theme } from "./theme";
import { buildToolLineParts, getTaskOutputDetails, toneColor } from "./tool-format";

export { getTaskOutputDetails } from "./tool-format";

// BLACK_CIRCLE — ⏺, matching the TUI status figure.
const DOT = "\u23FA";

/** Max rows shown at once — older entries roll off the top (mirrors TUI). */
export const LIVE_TOOL_PANEL_ROWS = 3;

/** A single tool action in the pinned feed — mirrors ggcoder's LiveToolEntry. */
export interface LiveToolEntry {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  isError?: boolean;
  result?: string;
  /** Bounded tail of streamed foreground bash output (running only). */
  progressOutput?: string;
  details?: unknown;
}

interface Props {
  entries: readonly LiveToolEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getBashDiagnostics(details: unknown): BashDiagnostics | null {
  if (!isRecord(details) || !isRecord(details.bashDiagnostics)) return null;
  const value = details.bashDiagnostics;
  const validReason = ["completed", "nonZeroExit", "timedOut", "aborted", "spawnError"].includes(
    String(value.reason),
  );
  if (
    typeof value.executionId !== "string" ||
    (typeof value.pid !== "number" && value.pid !== null) ||
    typeof value.command !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "number" ||
    typeof value.timeoutMs !== "number" ||
    !validReason ||
    (typeof value.exitCode !== "number" && value.exitCode !== null) ||
    (typeof value.signal !== "string" && value.signal !== null) ||
    typeof value.elapsedMs !== "number" ||
    typeof value.logPath !== "string" ||
    typeof value.tail !== "string" ||
    typeof value.outputCapped !== "boolean" ||
    typeof value.totalOutputBytes !== "number" ||
    typeof value.retainedOutputBytes !== "number" ||
    typeof value.droppedOutputBytes !== "number"
  ) {
    return null;
  }
  return (details as unknown as BashToolResultDetails).bashDiagnostics;
}

function diagnosticsText(diagnostics: BashDiagnostics): string {
  return [
    `ID: ${diagnostics.executionId}`,
    `PID: ${diagnostics.pid ?? "unavailable"}`,
    `Command: ${diagnostics.command}`,
    `CWD: ${diagnostics.cwd}`,
    `Started at: ${new Date(diagnostics.startedAt).toISOString()}`,
    `Timeout: ${diagnostics.timeoutMs}ms`,
    `Reason: ${diagnostics.reason}`,
    `Exit code: ${diagnostics.exitCode ?? "unavailable"}`,
    `Signal: ${diagnostics.signal ?? "none"}`,
    `Elapsed: ${diagnostics.elapsedMs}ms`,
    `Log: ${diagnostics.logPath}`,
    `Output capped: ${diagnostics.outputCapped ? "yes" : "no"}`,
    `Total output: ${diagnostics.totalOutputBytes} bytes`,
    `Retained output: ${diagnostics.retainedOutputBytes} bytes`,
    `Dropped output: ${diagnostics.droppedOutputBytes} bytes`,
    "",
    "Final output:",
    diagnostics.tail,
  ].join("\n");
}

function TaskOutputDetailsView({
  details,
  toolCallId,
}: {
  details: TaskOutputDetails;
  toolCallId: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const panelId = `task-output-details-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const terminalStatus = details.isRunning
    ? "Running"
    : details.signal
      ? `Exited with signal ${details.signal}`
      : details.exitCode !== null
        ? `Exited with code ${details.exitCode}`
        : "Completed";
  const guidance = [
    details.skippedBytes > 0
      ? "Earlier history was skipped. Read again with from_start=true to replay from byte 0."
      : null,
    details.remainingBytes > 0
      ? "More output is unread. Run task_output again to read the next page."
      : null,
    details.presentationCapped
      ? "This page was condensed for presentation. Use the retained log for the complete output."
      : null,
  ].filter((message): message is string => message !== null);

  return (
    <>
      <button
        type="button"
        className="tool-details-toggle"
        aria-label="Task output details"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        Details
      </button>
      {expanded ? (
        <div className="bash-diagnostics task-output-details" id={panelId}>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{terminalStatus}</dd>
            </div>
            <div>
              <dt>Exit code</dt>
              <dd>{details.exitCode ?? "unavailable"}</dd>
            </div>
            <div>
              <dt>Signal</dt>
              <dd>{details.signal ?? "none"}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                {details.completedAt === null
                  ? "unavailable"
                  : new Date(details.completedAt).toISOString()}
              </dd>
            </div>
            <div>
              <dt>Byte range</dt>
              <dd>
                {details.startOffset}-{details.endOffset} (end exclusive)
              </dd>
            </div>
            <div>
              <dt>Skipped</dt>
              <dd>{details.skippedBytes} bytes</dd>
            </div>
            <div>
              <dt>Unread</dt>
              <dd>{details.remainingBytes} bytes</dd>
            </div>
            <div>
              <dt>Retained log</dt>
              <dd>{details.logFile ?? "unavailable"}</dd>
            </div>
          </dl>
          {guidance.length > 0 ? (
            <ul className="task-output-guidance">
              {guidance.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function BashDiagnosticsDetails({
  diagnostics,
  toolCallId,
}: {
  diagnostics: BashDiagnostics;
  toolCallId: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = `bash-diagnostics-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const copyDiagnostics = (): void => {
    if (!navigator.clipboard) {
      setCopyState("failed");
      return;
    }
    void navigator.clipboard
      .writeText(diagnosticsText(diagnostics))
      .then(() => {
        setCopyState("copied");
        if (copyResetTimerRef.current !== null) {
          clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = setTimeout(() => {
          copyResetTimerRef.current = null;
          setCopyState("idle");
        }, 1_500);
      })
      .catch(() => setCopyState("failed"));
  };

  return (
    <>
      <button
        type="button"
        className="tool-details-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        Details
      </button>
      {expanded ? (
        <div className="bash-diagnostics" id={panelId}>
          <dl>
            <div>
              <dt>ID</dt>
              <dd>{diagnostics.executionId}</dd>
            </div>
            <div>
              <dt>PID</dt>
              <dd>{diagnostics.pid ?? "unavailable"}</dd>
            </div>
            <div>
              <dt>Command</dt>
              <dd>{diagnostics.command}</dd>
            </div>
            <div>
              <dt>CWD</dt>
              <dd>{diagnostics.cwd}</dd>
            </div>
            <div>
              <dt>Started at</dt>
              <dd>{new Date(diagnostics.startedAt).toISOString()}</dd>
            </div>
            <div>
              <dt>Timeout</dt>
              <dd>{diagnostics.timeoutMs}ms</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{diagnostics.reason}</dd>
            </div>
            <div>
              <dt>Exit code</dt>
              <dd>{diagnostics.exitCode ?? "unavailable"}</dd>
            </div>
            <div>
              <dt>Signal</dt>
              <dd>{diagnostics.signal ?? "none"}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd>{diagnostics.elapsedMs}ms</dd>
            </div>
            <div>
              <dt>Log path</dt>
              <dd>{diagnostics.logPath}</dd>
            </div>
            <div>
              <dt>Output capped</dt>
              <dd>{diagnostics.outputCapped ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Total output</dt>
              <dd>{diagnostics.totalOutputBytes} bytes</dd>
            </div>
            <div>
              <dt>Retained output</dt>
              <dd>{diagnostics.retainedOutputBytes} bytes</dd>
            </div>
            <div>
              <dt>Dropped output</dt>
              <dd>{diagnostics.droppedOutputBytes} bytes</dd>
            </div>
          </dl>
          <div className="bash-diagnostics-tail">
            <span>Final output</span>
            <pre aria-label="Final command output" tabIndex={0}>
              {diagnostics.tail || "(no output)"}
            </pre>
          </div>
          <button type="button" className="bash-diagnostics-copy" onClick={copyDiagnostics}>
            {copyState === "copied" ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy diagnostics"}
          </button>
          <span className="sr-only" aria-live="polite">
            {copyState === "copied"
              ? "Bash diagnostics copied"
              : copyState === "failed"
                ? "Could not copy bash diagnostics"
                : ""}
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * Pinned, in-place panel of recent tool actions — a rolling window of the last
 * few calls shown directly above the activity bar. Mirrors the TUI
 * LiveToolPanel: tools (running AND done) live ONLY here, never in the
 * scrollback transcript. Completed foreground bash and task_output rows expose
 * bounded diagnostics inline without replaying full process output.
 */
export function LiveToolPanel({ entries }: Props): React.ReactElement | null {
  if (entries.length === 0) return null;
  const visible = entries.slice(-LIVE_TOOL_PANEL_ROWS);

  return (
    <div className="livetoolpanel">
      {visible.map((entry) => {
        const done = entry.status === "done";
        const parts = buildToolLineParts(entry.name, entry.args, {
          done,
          isError: entry.isError,
          result: entry.result,
          progressOutput: entry.progressOutput,
          details: entry.details,
        });
        const dotColor = done ? (entry.isError ? theme.error : theme.success) : theme.primary;
        const diagnostics =
          done && entry.name === "bash" ? getBashDiagnostics(entry.details) : null;
        const taskOutput =
          done && entry.name === "task_output" ? getTaskOutputDetails(entry.details) : null;
        return (
          <div className="tool-entry" key={entry.toolCallId}>
            <div className="tool-row">
              <span className={`tool-dot${done ? "" : " blink"}`} style={{ color: dotColor }}>
                {DOT}
              </span>
              <span className="tool-line">
                {parts.map((part, index) => (
                  <span
                    key={`${index}-${part.text}`}
                    style={{
                      color: part.dim
                        ? theme.textDim
                        : part.tone
                          ? toneColor(part.tone)
                          : theme.text,
                      fontWeight: part.bold ? 600 : 400,
                    }}
                  >
                    {part.text}
                  </span>
                ))}
              </span>
              {diagnostics ? (
                <BashDiagnosticsDetails diagnostics={diagnostics} toolCallId={entry.toolCallId} />
              ) : null}
              {taskOutput ? (
                <TaskOutputDetailsView details={taskOutput} toolCallId={entry.toolCallId} />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
