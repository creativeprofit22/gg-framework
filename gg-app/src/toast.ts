// Tiny module-level toast bus so any component can raise a notification without
// threading a context through the tree. The <Toaster/> mounted once at the app
// root subscribes and renders them.
import { playSound } from "./sounds";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  /** Auto-dismiss after this many ms (0 = sticky). */
  duration: number;
}

type Listener = (toasts: Toast[]) => void;

/** Timed toasts get long enough to read a sentence. Errors default to sticky:
 *  a failure that vanishes before it's read is worse than one extra click. */
const DEFAULT_DURATION_MS = 4000;

interface DismissTimer {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, DismissTimer>();
let seq = 0;

function emit(): void {
  for (const l of listeners) l(toasts);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function startTimer(id: number, timer: DismissTimer): void {
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

/** Freeze a timed toast's countdown while it's hovered or focused (WCAG 2.2.1). */
export function pauseToast(id: number): void {
  const timer = timers.get(id);
  if (!timer?.handle) return;
  clearTimeout(timer.handle);
  timer.handle = null;
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
}

/** Resume a paused countdown with the time it had left. */
export function resumeToast(id: number): void {
  const timer = timers.get(id);
  if (!timer || timer.handle) return;
  startTimer(id, timer);
}

/** Raise a toast. Returns its id. De-dupes an identical message that's still up.
 *  Errors stay until dismissed unless a duration is passed. */
export function toast(
  message: string,
  tone: ToastTone = "info",
  duration = tone === "error" ? 0 : DEFAULT_DURATION_MS,
): number {
  const existing = toasts.find((t) => t.message === message && t.tone === tone);
  if (existing) return existing.id;
  const id = ++seq;
  toasts = [...toasts, { id, message, tone, duration }];
  if (tone === "warning" || tone === "error") playSound("warning");
  emit();
  if (duration > 0) {
    const timer: DismissTimer = { handle: null, remaining: duration, startedAt: 0 };
    timers.set(id, timer);
    startTimer(id, timer);
  }
  return id;
}
