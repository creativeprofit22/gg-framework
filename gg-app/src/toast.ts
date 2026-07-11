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

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
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
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Raise a toast. Returns its id. De-dupes an identical message that's still up by default. */
export function toast(
  message: string,
  tone: ToastTone = "info",
  duration = 4000,
  deduplicate = true,
): number {
  const existing = deduplicate
    ? toasts.find((t) => t.message === message && t.tone === tone)
    : undefined;
  if (existing) return existing.id;
  const id = ++seq;
  toasts = [...toasts, { id, message, tone, duration }];
  if (tone === "warning" || tone === "error") playSound("warning");
  emit();
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}
