interface Props {
  summary: string;
  /** Technical cause, collapsed under Details; omitted when null. */
  detail?: string | null;
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Lets a failed row point at this message with aria-describedby. */
  id?: string;
}

/**
 * The one picker error block: a plain-words summary, the raw cause tucked under
 * Details for bug reports, and a Retry that repeats the failed action.
 */
export function PickerError({
  summary,
  detail = null,
  onRetry,
  retryDisabled = false,
  id,
}: Props): React.ReactElement {
  return (
    <div className="picker-error" role="alert" id={id}>
      <div>{summary}</div>
      {detail && (
        <details className="picker-error-detail">
          <summary>Details</summary>
          <code>{detail}</code>
        </details>
      )}
      {onRetry && (
        <button
          type="button"
          className="btn btn-ghost btn-sm picker-error-retry"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
