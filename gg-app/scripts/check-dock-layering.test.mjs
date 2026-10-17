import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDockLayering, defaultTarget } from "./check-dock-layering.mjs";

/** A minimal pane with the same shape as AgentPane's render tree. */
function pane({ inDock = "", besideDock = "", root = "" } = {}) {
  return `
    export function Pane() {
      return (
        <div className={\`app agent-pane\${focused ? " pane-focused" : ""}\`}>
          <WorkspaceHeader />
          <Activity mode="visible">
            <div className="conversation-stack">
              <div className="transcript-frame" />
            </div>
            <div ref={dockRef} className="dock">
              ${inDock}
              <Deck />
            </div>
            ${besideDock}
          </Activity>
          {open && <ConfirmModal />}
          <div className="visually-hidden" aria-live="polite" />
          ${root}
        </div>
      );
    }`;
}

describe("dock layering build gate", () => {
  it("passes the real AgentPane", () => {
    expect(checkDockLayering(readFileSync(defaultTarget, "utf8"))).toEqual([]);
  });

  it("passes when every required surface is inside the dock", () => {
    const source = pane({
      inDock: `
        <ReviewDock items={items} />
        {error && <div role="status" className="roadmap-draft-refresh-error" />}
        {phase === "available" ? <button className="update-banner" /> : null}`,
    });
    expect(checkDockLayering(source)).toEqual([]);
  });

  it("rejects the review dock beside the floating dock (the 0.91 regression)", () => {
    const problems = checkDockLayering(pane({ besideDock: "<ReviewDock items={items} />" }));
    expect(problems.join("\n")).toMatch(/review dock \(<ReviewDock>\) is rendered outside/);
    expect(problems.join("\n")).toMatch(/sibling of the floating dock/);
  });

  it("rejects the review dock inside the conversation stack", () => {
    const source = pane().replace(
      '<div className="transcript-frame" />',
      '<div className="transcript-frame" /><ReviewDock items={items} />',
    );
    expect(checkDockLayering(source).join("\n")).toMatch(/ReviewDock.*outside the floating dock/);
  });

  it("rejects conditional update banners after the dock", () => {
    const problems = checkDockLayering(
      pane({
        besideDock: '{phase === "installing" && <div className={`update-banner ${busy}`} />}',
      }),
    );
    expect(problems.join("\n")).toMatch(/update banner \(\.update-banner\) is rendered outside/);
  });

  it("rejects an unlisted in-flow root child but allows modals and hidden live regions", () => {
    const problems = checkDockLayering(
      pane({
        root: '<div role="status" className="roadmap-draft-refresh-error" /><NewThingModal />',
      }),
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/Roadmap refresh recovery/);
    expect(problems.join("\n")).toMatch(/new in-flow child of the pane root/);
    expect(problems.join("\n")).not.toMatch(/NewThingModal/);
  });

  it("fails closed when the dock can't be found", () => {
    expect(checkDockLayering(pane().replace('className="dock"', 'className="bottom"'))).toEqual([
      expect.stringMatching(/expected exactly one floating dock/),
    ]);
  });
});
