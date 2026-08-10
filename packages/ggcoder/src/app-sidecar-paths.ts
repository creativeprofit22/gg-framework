import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";

export function appSettingsFile(): string {
  return path.join(getAppPaths().agentDir, "gg-app.json");
}
