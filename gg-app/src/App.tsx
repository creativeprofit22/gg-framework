import { AgentPane, type Item as AgentPaneItem } from "./AgentPane";
import { WorkspaceShell } from "./WorkspaceShell";

export type Item = AgentPaneItem;

export default function App(): React.ReactElement {
  return <WorkspaceShell renderPane={(props) => <AgentPane {...props} />} />;
}
