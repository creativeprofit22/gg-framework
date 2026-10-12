import { spawnedTasks } from "../tools/subagent-shared.js";

/**
 * The worker rows a restored transcript shows for one delegation call. A
 * refused spawn started no worker (live bug: a spawn blocked during a goal's
 * briefing came back after a restart as "critters didn't make it back").
 */
export function restoredWorkerRows(
  call: { readonly name: string; readonly args: Record<string, unknown> },
  resultIsError: boolean | null,
): Array<{ agentName: string | undefined; status: "done" | "error"; toolUseCount: number }> {
  const status = resultIsError ? ("error" as const) : ("done" as const);
  if (call.name === "spawn_agent") {
    if (resultIsError) return [];
    // One row per child: a batch call starts several.
    return spawnedTasks(call.args).map((spawn) => ({
      agentName: spawn.task_name ?? spawn.agent,
      status,
      toolUseCount: 0,
    }));
  }
  return [
    {
      agentName: typeof call.args.agent === "string" ? call.args.agent : undefined,
      status,
      toolUseCount: 0,
    },
  ];
}
