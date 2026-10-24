import type { ProgrammaticExecutionEvidence } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";

/** One plain word per evidence basis, shared by every Opportunities view. */
export const evidenceBasisLabel = (basis: ProgrammaticExecutionEvidence["basis"]) =>
  basis === "observed" ? "Checked" : basis === "inferred" ? "Best guess" : "Assumed";

/** Plain text only: citations are not executable links or rendered Markdown. */
export function ProgrammaticExecutionEvidenceView({
  items,
}: {
  items: ProgrammaticExecutionEvidence[];
}) {
  return (
    <section className="programmatic-chat" data-swap-row="" aria-label="What the task found">
      <h4>What the task found</h4>
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            <Badge>{evidenceBasisLabel(item.basis)}</Badge>{" "}
            {item.severity !== "info" && (
              <strong>{item.severity === "warning" ? "Warning: " : "Error: "}</strong>
            )}
            <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.message}</span>
            {item.location && (
              <>
                {" "}
                <code>
                  {item.location.path}
                  {item.location.startLine ? `:${item.location.startLine}` : ""}
                  {item.location.endLine ? `–${item.location.endLine}` : ""}
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
