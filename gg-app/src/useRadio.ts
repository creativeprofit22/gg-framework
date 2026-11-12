import { useCallback, useEffect, useRef, useState } from "react";
import { getRadioState, setRadio, setRadioVolume, type RadioStation } from "./agent";

export interface Radio {
  stations: RadioStation[];
  /** The station the player points at: the one playing, else the last picked. */
  selected: string;
  /** The station playing app-wide, or null while paused. */
  current: string | null;
  volume: number;
  busy: boolean;
  error: string | null;
  /** Re-read the app-wide state (another window may have changed it). */
  refresh: () => void;
  togglePlayback: () => void;
  /** Point at a station; switches playback to it when something is playing. */
  changeStation: (station: string) => void;
  /** Move the volume while dragging; `saveVolume` commits it. */
  updateVolume: (volume: number) => void;
  saveVolume: () => void;
}

/**
 * The app-wide internet radio: stations, playback and volume. The sidecar owns
 * the player, so every window reads the same state; `refresh` re-reads it when
 * a surface opens, since another window may have changed it in the meantime.
 */
export function useRadio(): Radio {
  const [busy, setBusy] = useState(false);
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [selected, setSelected] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [volume, setVolume] = useState(70);
  const [error, setError] = useState<string | null>(null);
  const volumeRef = useRef(70);
  const syncedVolumeRef = useRef(70);
  const volumeSaveRef = useRef(0);
  const busyRef = useRef(false);

  const applyState = useCallback((state: Awaited<ReturnType<typeof getRadioState>>): void => {
    setStations(state.stations);
    setCurrent(state.current);
    setSelected((previous) => state.current ?? (previous || state.stations[0]?.id || ""));
    volumeRef.current = state.volume;
    syncedVolumeRef.current = state.volume;
    setVolume(state.volume);
  }, []);

  const refresh = useCallback((): void => {
    // A failed read (sidecar restarting, no native bridge) keeps the last
    // known stations instead of surfacing as an unhandled rejection.
    void getRadioState().then(applyState, (error: unknown) => {
      console.warn("radio state read failed", error);
    });
  }, [applyState]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateVolume = useCallback((nextVolume: number): void => {
    volumeRef.current = nextVolume;
    setVolume(nextVolume);
  }, []);

  const saveVolume = useCallback((): void => {
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
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [updateVolume]);

  const play = useCallback(async (station: string): Promise<void> => {
    if (busyRef.current || !station) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      setCurrent(await setRadio(station));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const togglePlayback = useCallback((): void => {
    void play(current === null ? selected : "off");
  }, [current, play, selected]);

  const changeStation = useCallback(
    (station: string): void => {
      setSelected(station);
      if (current !== null) void play(station);
    },
    [current, play],
  );

  return {
    stations,
    selected,
    current,
    volume,
    busy,
    error,
    refresh,
    togglePlayback,
    changeStation,
    updateVolume,
    saveVolume,
  };
}
