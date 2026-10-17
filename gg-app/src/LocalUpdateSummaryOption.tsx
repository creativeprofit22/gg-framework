import {
  LOCAL_UPDATE_SUMMARY_DISCLOSURE,
  LOCAL_UPDATE_SUMMARY_LABEL,
} from "./local-update-confirmation";

export function LocalUpdateSummaryOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <label className="local-update-summary-option">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        <strong>{LOCAL_UPDATE_SUMMARY_LABEL}</strong>
        <small>{LOCAL_UPDATE_SUMMARY_DISCLOSURE}</small>
      </span>
    </label>
  );
}
