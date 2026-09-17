import type { ProgrammaticExecutionEvidence } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";

/** Plain text only: citations are not executable links or rendered Markdown. */
export function ProgrammaticExecutionEvidenceView({ items }: { items: ProgrammaticExecutionEvidence[] }) {
  return (
    <section className="programmatic-chat" aria-label="Task execution evidence">
      <h4>Task execution evidence</h4>
      <ul>{items.map((item, index) => (
        <li key={index}>
          <Badge>{item.basis === "observed" ? "Checked directly" : item.basis === "inferred" ? "Inferred, not confirmed" : "Assumed, not checked"}</Badge>{" "}
          {item.severity !== "info" && <strong>{item.severity === "warning" ? "Warning: " : "Error: "}</strong>}
          <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.message}</span>
          {item.location && <>{" "}<code>{item.location.path}{item.location.startLine ? `:${item.location.startLine}` : ""}{item.location.endLine ? `–${item.location.endLine}` : ""}</code></>}
        </li>
      ))}</ul>
    </section>
  );
}
