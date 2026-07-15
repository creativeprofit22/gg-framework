import { WorkspaceShell } from "./WorkspaceShell";
import "./App.css";

export type { Item } from "./transcript-types";

export default function App(): React.ReactElement {
  return <WorkspaceShell />;
}
