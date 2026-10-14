import type { UpdateInfo } from "./update";
import { SPARKLE_SRC } from "./update-key-art";
import { KEY_ART_STYLE, PixelText, UpdateArrow, UpdateBurst, UpdateMeter } from "./UpdateKeyParts";
import "./HomeUpdateButton.css";

/**
 * The home screen's update button, as an arcade key: a pixel plate with a gold
 * rim standing on its own dark-gold side, so pressing it pushes the face down.
 * When an update arrives, UPDATE's pixels fly in and snap together beside a
 * hopping arrow, and the versions it goes from and to. Installing turns the
 * face into an XP bar with the builder running along the top; at 100% it reads
 * UPDATED! and goes off in a burst of pixels.
 */
export function HomeUpdateButton({
  appUpdate,
  current,
}: {
  appUpdate: Pick<UpdateInfo, "phase" | "version" | "progress" | "install">;
  /** The installed version, for the "from" side of the label. */
  current: string | null;
}): React.ReactElement | null {
  const { phase, version, progress } = appUpdate;
  if (phase !== "available" && phase !== "installing") return null;
  const installing = phase === "installing";
  const pct = Math.max(0, Math.min(100, Math.round(progress ?? 0)));
  const done = installing && pct >= 100;

  const label = installing
    ? done
      ? "Update installed. Restarting."
      : `Installing update, ${pct}%`
    : `Update to ${version ?? "the latest version"}. Installs and restarts the app.`;

  return (
    <button
      type="button"
      className={`home-update${installing ? " is-installing" : ""}${done ? " is-done" : ""}`}
      style={KEY_ART_STYLE}
      disabled={installing}
      aria-label={label}
      title={installing ? undefined : `Update to ${version ?? "the latest version"}`}
      onClick={() => void appUpdate.install()}
    >
      <span className="lvl-base" aria-hidden="true" />
      <span className="lvl-face" aria-hidden="true">
        {!installing ? (
          <>
            <UpdateArrow />
            <PixelText text="Update" cell={3} fly />
            <span className="lvl-versions">
              {current && <span>{`v${current}`}</span>}
              <span className="lvl-versions-to">{current ? "\u2192" : ""}</span>
              <span className="lvl-versions-new">{`v${version ?? ""}`}</span>
            </span>
          </>
        ) : done ? (
          <PixelText text="Updated!" cell={3} fly spread={30} />
        ) : (
          <>
            <PixelText text="XP" cell={3} />
            <UpdateMeter pct={pct} />
            <PixelText text={`${pct}%`} cell={3} minCols={15} />
          </>
        )}
      </span>
      {!installing && (
        <>
          <img className="lvl-sparkle lvl-sparkle-a" src={SPARKLE_SRC} alt="" aria-hidden="true" />
          <img className="lvl-sparkle lvl-sparkle-b" src={SPARKLE_SRC} alt="" aria-hidden="true" />
        </>
      )}
      {done && <UpdateBurst />}
      {/* Said once when the install starts, not at every percent. */}
      <span className="sr-only" aria-live="polite">
        {installing ? (done ? "Update installed. Restarting." : "Installing update.") : ""}
      </span>
    </button>
  );
}
