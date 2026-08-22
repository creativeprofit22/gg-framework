import { WorkspaceShell } from "./WorkspaceShell";
import type { Item as AgentPaneItem } from "./AgentPane";
import "./App.css";

// Preserve the upstream queued→sent transition flag without coupling the
// refactored AgentPane transcript model to event-projection internals.
export type Item = AgentPaneItem extends infer Entry
  ? Entry extends { kind: "user" }
    ? Entry & { promoted?: boolean }
    : Entry
  : never;

export default function App(): React.ReactElement {
  return <WorkspaceShell />;
}
