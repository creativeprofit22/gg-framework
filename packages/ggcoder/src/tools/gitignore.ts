import fs from "node:fs/promises";
import path from "node:path";

export async function loadGitignore(directory: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(directory, ".gitignore"), "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}
