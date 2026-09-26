import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Pause, Play, Radio, Volume2 } from "lucide-react";
import { theme } from "./theme";
import { getRadioState, setRadio, setRadioVolume, type RadioStation } from "./agent";
import { Modal } from "./Modal";
import { Dropdown } from "./Dropdown";

/** Station list outcome: a failed read is not the same as an empty list. */
type RadioStatus = "loading" | "ready" | "empty" | "failed";

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Titlebar control and modal player for the app-wide internet radio. */
export function RadioButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RadioStatus>("loading");
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [selected, setSelected] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [volume, setVolume] = useState(70);
  const [error, setError] = useState<string | null>(null);
  const volumeRef = useRef(70);
  const syncedVolumeRef = useRef(70);
  const volumeSaveRef = useRef(0);
  // Each state read gets a sequence number; only the newest may apply, so a
  // slow mount read can't overwrite a fresher read made when the modal opened.
  const loadSeqRef = useRef(0);
  const volumeId = useId();

  const load = useCallback((): void => {
    const seq = ++loadSeqRef.current;
    // A background refresh of an already-loaded list keeps it on screen.
    setStatus((previous) => (previous === "ready" ? previous : "loading"));
    getRadioState()
      .then((state) => {
        if (loadSeqRef.current !== seq) return;
        setStations(state.stations);
        setCurrent(state.current);
        setSelected((previous) => state.current ?? (previous || state.stations[0]?.id || ""));
        volumeRef.current = state.volume;
        syncedVolumeRef.current = state.volume;
        setVolume(state.volume);
        setStatus(state.stations.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (loadSeqRef.current !== seq) return;
        setStatus("failed");
      });
  }, []);

  useEffect(() => {
    load();
    return () => {
      // Ignore any read still in flight after unmount.
      loadSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (open) load();
  }, [load, open]);

  function updateVolume(nextVolume: number): void {
    volumeRef.current = nextVolume;
    setVolume(nextVolume);
  }

  function saveVolume(): void {
    const nextVolume = volumeRef.current;
    const previousVolume = syncedVolumeRef.current;
    if (nextVolume === previousVolume) return;
    const saveId = ++volumeSaveRef.current;
    syncedVolumeRef.current = nextVolume;
    setError(null);
    void setRadioVolume(nextVolume)
      .then((saved) => {
        if (volumeSaveRef.current !== saveId) return;
        syncedVolumeRef.current = saved;
        if (volumeRef.current === nextVolume) updateVolume(saved);
      })
      .catch((reason: unknown) => {
        if (volumeSaveRef.current !== saveId) return;
        syncedVolumeRef.current = previousVolume;
        // Show the volume that is actually in effect, unless the user has
        // already moved the slider again since this save started.
        if (volumeRef.current === nextVolume) updateVolume(previousVolume);
        setError(
          `Couldn't change the volume; it stays at ${previousVolume}%. ${reasonText(reason)}`,
        );
      });
  }

  async function play(station: string): Promise<void> {
    if (busy || !station) return;
    setBusy(true);
    setError(null);
    try {
      setCurrent(await setRadio(station));
    } catch (reason) {
      setError(reasonText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function togglePlayback(): Promise<void> {
    await play(current === null ? selected : "off");
  }

  function changeStation(station: string): void {
    setSelected(station);
    if (current !== null) void play(station);
  }

  const playing = current !== null;
  const ready = status === "ready";
  const selectedStation = stations.find((station) => station.id === selected);
  const buttonLabel = playing ? "Radio playing" : "Internet radio";
  const placeholder =
    status === "loading"
      ? "Loading stations\u2026"
      : status === "empty"
        ? "No stations available"
        : status === "failed"
          ? "Stations unavailable"
          : "Choose a station";

  return (
    <>
      <button
        className="btn btn-ghost btn-sm btn-nav-icon"
        title={buttonLabel}
        aria-label={buttonLabel}
        style={playing ? { color: theme.accent } : undefined}
        onClick={() => setOpen(true)}
      >
        <Radio size={16} aria-hidden="true" />
      </button>
      {open && (
        <Modal title="Internet Radio" onClose={() => setOpen(false)} className="radio-modal">
          {/* Dropdown names itself "Station"; this is its visible caption. */}
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Station
          </div>
          <Dropdown
            label="Station"
            options={stations.map((station) => ({
              value: station.id,
              label: station.name,
              description: station.description,
            }))}
            value={selected}
            disabled={busy || !ready}
            placeholder={placeholder}
            onChange={changeStation}
          />
          {status === "failed" || status === "empty" ? (
            <div className="modal-row radio-load-status" role="alert">
              <span className="modal-hint" style={{ color: theme.textMuted }}>
                {status === "failed"
                  ? "Couldn\u2019t load radio stations."
                  : "No radio stations are available right now."}
              </span>
              <button className="modal-btn" onClick={load}>
                Retry
              </button>
            </div>
          ) : (
            <div
              className="modal-hint radio-station-description"
              style={{ color: theme.textMuted }}
            >
              {status === "loading"
                ? "Loading stations\u2026"
                : (selectedStation?.description ?? "Choose a station to start listening.")}
            </div>
          )}

          <div className="radio-player-row">
            <button
              className="modal-btn primary radio-play-button"
              disabled={busy || !ready || !selected}
              onClick={() => void togglePlayback()}
            >
              {playing ? <Pause size={17} /> : <Play size={17} />}
              {playing ? "Pause" : "Play"}
            </button>
          </div>

          <div className="radio-volume-heading">
            <label className="modal-label" htmlFor={volumeId} style={{ color: theme.textMuted }}>
              Volume
            </label>
            <span style={{ color: theme.textMuted }}>{volume}%</span>
          </div>
          <div className="radio-volume-row">
            <Volume2 size={17} color={theme.textMuted} aria-hidden="true" />
            <div className="radio-volume-slider">
              <div className="radio-volume-track">
                <div className="radio-volume-fill" style={{ width: `${volume}%` }} />
              </div>
              <input
                id={volumeId}
                className="radio-volume-input"
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(event) => updateVolume(Number(event.target.value))}
                onPointerUp={saveVolume}
                onPointerCancel={saveVolume}
                onKeyUp={saveVolume}
                onBlur={saveVolume}
              />
            </div>
          </div>

          {error && (
            <div className="modal-hint" role="alert" style={{ color: theme.error }}>
              {error}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
