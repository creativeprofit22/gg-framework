import type { Dispatch, SetStateAction } from "react";
import { ConfirmModal } from "./ConfirmModal";
import { LocalUpdateSummaryOption } from "./LocalUpdateSummaryOption";
import {
  LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL,
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  LOCAL_UPDATE_CONFIRMATION_TITLE,
} from "./local-update-confirmation";
import type { UpdateInfo } from "./update";

/** Confirms the Local Fork merge-and-build update, with the optional Decisions summary. */
export function LocalUpdateConfirmModal({
  summarizeDecisions,
  setSummarizeDecisions,
  setShowLocalUpdateConfirm,
  install,
}: {
  summarizeDecisions: boolean;
  setSummarizeDecisions: Dispatch<SetStateAction<boolean>>;
  setShowLocalUpdateConfirm: Dispatch<SetStateAction<boolean>>;
  install: UpdateInfo["install"];
}): React.ReactElement {
  return (
    <ConfirmModal
      title={LOCAL_UPDATE_CONFIRMATION_TITLE}
      message={LOCAL_UPDATE_CONFIRMATION_MESSAGE}
      confirmLabel={LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL}
      content={
        <LocalUpdateSummaryOption checked={summarizeDecisions} onChange={setSummarizeDecisions} />
      }
      onConfirm={() => {
        setShowLocalUpdateConfirm(false);
        void install({ summarizeDecisions });
        setSummarizeDecisions(false);
      }}
      onClose={() => {
        setShowLocalUpdateConfirm(false);
        setSummarizeDecisions(false);
      }}
    />
  );
}
