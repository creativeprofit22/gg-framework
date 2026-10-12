import { theme } from "./theme";
import {
  cycleThinking,
  workspaceProductName,
  type AgentState,
  type BackgroundTask,
  type ModelOption,
  type WorkspaceMode,
} from "./agent";
import { FooterSkeleton } from "./Skeleton";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { RunningSchedulesButton } from "./RunningSchedulesButton";
import { ShimmerText } from "./ShimmerText";
import { ContextMeter } from "./ContextMeter";
import { GgFace } from "./GgFace";
import { KenFace } from "./KenFace";
import { CritterIcon } from "./CritterIcon";
import { ModelSelect } from "./ModelSelect";
import type { Schedules } from "./useSchedules";

// Vertical divider between footer segments (mirrors the TUI's ` \u2502 ` in
// border color). Rendered between adjacent groups, never leading/trailing.
function FooterSep(): React.ReactElement {
  return (
    <span className="footer-sep" style={{ color: theme.border }}>
      {"\u2502"}
    </span>
  );
}

// Thinking-tier color, mirroring the ggcoder TUI footer's getThinkingColor:
// warmer/more saturated as the tier rises; xhigh/max are "max power" hot pink.
const MAX_POWER_COLOR = "#db2777";
const MAX_POWER_SHIMMER = "#f472b6";
// Plan-mode footer shimmer highlight; mirrors ggcoder Footer.tsx PLAN_SHIMMER_COLOR.
const PLAN_SHIMMER_COLOR = "#ddd6fe";
function thinkingColor(level: string | null | undefined): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return MAX_POWER_COLOR; // xhigh / max
}

/** The status footer under the composer: tasks/schedules/plan mode on the left, context + thinking + model pickers on the right. */
export function AppFooter({
  hydrated,
  workspaceMode,
  state,
  tasks,
  schedules,
  stopSchedule,
  runningTaskCount,
  contextUsed,
  contextWindow,
  running,
  kenRunning,
  autopilotReviewing,
  models,
  modelsFailed,
  onSelectModel,
  onSelectKenModel,
  onSelectCritterModel,
}: {
  hydrated: boolean;
  workspaceMode: WorkspaceMode;
  state: AgentState | null;
  tasks: BackgroundTask[];
  schedules: Schedules["schedules"];
  stopSchedule: Schedules["stopSchedule"];
  runningTaskCount: number;
  /** Context tokens in use and the model window (ContextMeter contract). */
  contextUsed: number;
  contextWindow: number;
  running: boolean;
  kenRunning: boolean;
  autopilotReviewing: boolean;
  models: ModelOption[];
  modelsFailed: boolean;
  onSelectModel: (modelId: string) => void;
  onSelectKenModel: (modelId: string | null) => void;
  /** A Goal window: pin the workers' model, or null to follow GG Goals. */
  onSelectCritterModel?: (modelId: string | null) => void;
}): React.ReactElement {
  const goal = state?.goal ?? null;
  return (
    <div
      className={`footer${workspaceMode !== "code" ? " footer-chat" : ""}`}
      style={{ color: theme.footerText }}
    >
      {!hydrated ? (
        <FooterSkeleton />
      ) : (
        <>
          {workspaceMode === "motion" ? (
            <span className="footer-left footer-reveal" style={{ color: theme.textDim }}>
              Motion Agent
            </span>
          ) : workspaceMode === "chat" ? (
            <span className="footer-left footer-reveal" style={{ color: theme.textDim }}>
              {state?.chatAgent === "therapist"
                ? "Therapist Agent"
                : state?.chatAgent === "research"
                  ? "Research Agent"
                  : "General Agent"}
            </span>
          ) : (
            <span className="footer-left footer-reveal">
              <BackgroundTasksButton tasks={tasks} />
              {schedules.length > 0 && runningTaskCount > 0 && <FooterSep />}
              <RunningSchedulesButton schedules={schedules} onStop={stopSchedule} />
              {state?.planMode && (
                <>
                  {(runningTaskCount > 0 || schedules.length > 0) && <FooterSep />}
                  <span className="footer-plan">
                    <ShimmerText base={theme.secondary} bright={PLAN_SHIMMER_COLOR}>
                      {"\u25C6 plan mode"}
                    </ShimmerText>
                  </span>
                </>
              )}
            </span>
          )}
          <span className="footer-right footer-reveal">
            {contextUsed > 0 && contextWindow > 0 && (
              <>
                <ContextMeter used={contextUsed} window={contextWindow} />
                <FooterSep />
              </>
            )}
            {(state?.supportedThinkingLevels?.length ?? 0) > 0 &&
              (() => {
                const level = state?.thinkingLevel ?? null;
                const label = level ? `Thinking ${level}` : "Thinking off";
                const maxPower = level === "xhigh" || level === "max";
                // Reasoning level is baked into the request the run is already
                // streaming, so a mid-turn cycle changes nothing about it and
                // silently disagrees with what the footer shows. Lock it like
                // the model pickers, and say why rather than going inert.
                const locked = running;
                return (
                  <>
                    <button
                      className="thinking-toggle"
                      style={{
                        color: locked ? theme.textDim : thinkingColor(level),
                        fontWeight: level === "high" ? 600 : 400,
                      }}
                      title={
                        locked
                          ? "Can't change reasoning level while the agent is running — cancel the run or wait for it to finish"
                          : "Cycle reasoning level"
                      }
                      disabled={locked}
                      onClick={() => void cycleThinking()}
                    >
                      {maxPower && !locked ? (
                        <ShimmerText base={MAX_POWER_COLOR} bright={MAX_POWER_SHIMMER}>
                          {label}
                        </ShimmerText>
                      ) : (
                        label
                      )}
                    </button>
                    <FooterSep />
                  </>
                );
              })()}
            <span className="model-anchor">
              <span className="model-label" style={{ color: theme.text }}>
                <GgFace mood="ready" />
                GG
              </span>
              <ModelSelect
                models={models}
                currentModel={state?.model ?? ""}
                onSelect={onSelectModel}
                disabled={running}
                loadFailed={modelsFailed}
                title={`Switch ${workspaceMode === "chat" ? "GG" : workspaceProductName(workspaceMode, Boolean(state?.goal))}'s model`}
              />
            </span>
            {goal && onSelectCritterModel ? (
              <>
                <FooterSep />
                <span className="model-anchor">
                  <span className="model-label" style={{ color: theme.critter }}>
                    <CritterIcon />
                    Critters
                  </span>
                  <ModelSelect
                    models={models}
                    currentModel={goal.critterModel ?? state?.model ?? ""}
                    onSelect={(id) => onSelectCritterModel(id)}
                    color={theme.critter}
                    // Applies to the next worker GG Goals starts; running
                    // workers keep theirs, so it never needs locking.
                    loadFailed={modelsFailed}
                    title={
                      goal.critterModel
                        ? "Critters are pinned to their own model. Click to change"
                        : "Critters follow GG Goals' model. Click to pin one"
                    }
                    onSelectFollow={() => onSelectCritterModel(null)}
                    followActive={!goal.critterModel}
                    followLabel="GG Goals"
                  />
                </span>
              </>
            ) : (
              workspaceMode === "code" && (
                <>
                  <FooterSep />
                  <span className="model-anchor">
                    <span className="model-label" style={{ color: theme.ken }}>
                      <KenFace mood="chat" />
                      Ken
                    </span>
                    <ModelSelect
                      models={models}
                      currentModel={state?.kenModel ?? state?.model ?? ""}
                      onSelect={(id) => onSelectKenModel(id)}
                      color={theme.ken}
                      // Ken's pin retargets BOTH his sessions (chat + the
                      // autopilot reviewer), so it has to stay locked while
                      // either is mid-turn — same rule the GG picker follows,
                      // and the sidecar now answers 409 to match.
                      disabled={running || kenRunning || autopilotReviewing}
                      loadFailed={modelsFailed}
                      title={
                        state?.kenModelOverride
                          ? "Ken is pinned to his own model — click to change"
                          : "Ken follows GG Coder's model — click to pin one"
                      }
                      onSelectFollow={() => onSelectKenModel(null)}
                      followActive={!state?.kenModelOverride}
                    />
                  </span>
                </>
              )
            )}
          </span>
        </>
      )}
    </div>
  );
}
