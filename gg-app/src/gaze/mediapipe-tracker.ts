import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { dependencies } from "../../package.json";
import type { GazeSample, GazeTracker } from "./types";

// Webcam head-pose tracker built on MediaPipe Face Landmarker. We deliberately
// drive focus from HEAD POSE rather than true pupil gaze: head yaw/pitch is far
// more stable than iris estimation and is plenty to answer "which of 2–4 tiled
// windows am I facing". Pixel-accurate gaze is overkill (and jittery) for that.
//
// The horizontal/vertical turn is derived from landmark geometry (nose offset
// relative to the face-oval extremes) instead of decoding the transformation
// matrix's Euler angles — it's layout-agnostic and robust to scale/distance.
//
// WASM + model load from CDN (the app's CSP is unrestricted). This keeps the
// bundle light; a slow/blocked network simply makes the tracker unavailable and
// the controller falls back without the feature.

// Keep the SDK pinned exactly: its native runtime must come from the same release.
const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${dependencies["@mediapipe/tasks-vision"]}/wasm`;
const MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Canonical FaceMesh landmark indices.
const NOSE = 1;
const FACE_LEFT = 234; // image-left face-oval extreme
const FACE_RIGHT = 454; // image-right face-oval extreme
const FOREHEAD = 10;
const CHIN = 152;

function num(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v !== 0 ? v : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  return v == null ? fallback : v === "1" || v === "true";
}

export function createMediaPipeTracker(): GazeTracker {
  let landmarker: FaceLandmarker | null = null;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let raf = 0;
  let running = false;
  let lastVideoTs = -1;

  return {
    kind: "camera",
    async start(onSample: (s: GazeSample) => void): Promise<void> {
      // Tunables — calibrate per machine via localStorage, no rebuild needed.
      const gainX = num("gg-app:gaze:gainX", 2.4);
      const gainY = num("gg-app:gaze:gainY", 2.6);
      const invertX = bool("gg-app:gaze:invertX", true);
      const invertY = bool("gg-app:gaze:invertY", false);

      const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_CDN, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      });

      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: false,
      });
      video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      running = true;
      const loop = (): void => {
        if (!running || !landmarker || !video) return;
        // detectForVideo requires strictly increasing timestamps; skip frames
        // the camera hasn't advanced yet.
        if (video.currentTime !== lastVideoTs && video.readyState >= 2) {
          lastVideoTs = video.currentTime;
          let result: FaceLandmarkerResult | null;
          try {
            result = landmarker.detectForVideo(video, performance.now());
          } catch {
            result = null;
          }
          const lm = result?.faceLandmarks?.[0];
          if (lm && lm.length > CHIN) {
            // Horizontal turn: nose offset from the face-oval midpoint, scaled
            // by face width → roughly [-0.5, 0.5].
            const width = lm[FACE_RIGHT].x - lm[FACE_LEFT].x || 1e-3;
            const midX = (lm[FACE_LEFT].x + lm[FACE_RIGHT].x) / 2;
            let yaw = (lm[NOSE].x - midX) / width;
            // Vertical turn: nose offset between forehead and chin.
            const height = lm[CHIN].y - lm[FOREHEAD].y || 1e-3;
            const midY = (lm[FOREHEAD].y + lm[CHIN].y) / 2;
            let pitch = (lm[NOSE].y - midY) / height;

            if (invertX) yaw = -yaw;
            if (invertY) pitch = -pitch;

            const nx = Math.min(1, Math.max(0, 0.5 + gainX * yaw));
            const ny = Math.min(1, Math.max(0, 0.5 + gainY * pitch));
            onSample({ nx, ny, confidence: 1, ts: performance.now() });
          } else {
            onSample({ nx: 0.5, ny: 0.5, confidence: 0, ts: performance.now() });
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    },
    stop(): void {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) {
        video.srcObject = null;
        video = null;
      }
      landmarker?.close();
      landmarker = null;
      lastVideoTs = -1;
    },
  };
}
