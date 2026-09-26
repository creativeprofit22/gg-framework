import { invoke } from "@tauri-apps/api/core";
import { error as logError } from "@tauri-apps/plugin-log";
import {
  isNotesPhasePresent,
  notesPhaseDeletionGeneration,
} from "@kenkaiiii/gg-core/project-notes";
import { isSoundEnabled } from "./sounds";
import type {
  NotesClient,
  NotesDocumentV3,
  NotesReminderMutationResult,
  NotesReminderPermission,
  ProjectNotesSnapshot,
  ReminderClaimOutcome,
  ReservedReminderOccurrence,
} from "./notes-types";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const TRANSPORT_RETRY_BASE_DELAY_MS = 1_000;
const TRANSPORT_RETRY_LIMIT = 3;

export interface ReminderPresetTimes {
  laterToday: Date | null;
  tomorrow: Date;
}

export function reminderPresetTimes(now: Date): ReminderPresetTimes {
  return {
    laterToday: laterTodayReminderTime(now),
    tomorrow: tomorrowReminderTime(now),
  };
}

export function laterTodayReminderTime(now: Date): Date | null {
  const rounded = new Date(
    Math.ceil((now.getTime() + TWO_HOURS_MS) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS,
  );
  return isSameLocalDate(now, rounded) ? rounded : null;
}

export function tomorrowReminderTime(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
}

export function localDateTimeToIso(value: string, now: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute ||
    local.getTime() <= now.getTime()
  ) {
    return null;
  }
  return local.toISOString();
}

export function dateToLocalInputValue(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function reminderMutationResultMessage(
  result: NotesReminderMutationResult,
  context: "standalone" | "resume-cleanup" = "standalone",
): string {
  let message: string;
  if (result.status === "committed") {
    message = "Reminder saved.";
  } else if (result.status === "invalid-time") {
    message = "Choose a future reminder time.";
  } else if (result.status === "missing-reminder") {
    message = "This reminder is no longer scheduled.";
  } else if (result.status === "stale-occurrence") {
    message = "This reminder changed in another window. Review the latest reminder.";
  } else if (
    result.status === "missing-phase" ||
    result.status === "archived-phase" ||
    result.status === "inactive-phase"
  ) {
    message = "This phase is no longer eligible for reminders.";
  } else if (result.reason === "validation") {
    message = "Project Notes rejected the reminder change. Review it and try again.";
  } else if (result.reason === "storage") {
    message = "The reminder change could not be saved to Notes storage. Try again.";
  } else {
    message = "Reminder storage is unavailable. Reopen the project and try again.";
  }

  return context === "resume-cleanup" && result.status !== "committed"
    ? `The phase resumed, but reminder cleanup did not complete. ${message}`
    : message;
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export interface InAppReminderDelivery extends ReservedReminderOccurrence {
  snapshot: ProjectNotesSnapshot;
}

export type NativeNotificationPermission = Extract<
  NotesReminderPermission,
  "granted" | "denied" | "unavailable"
>;

/** Scoped identity of one reminder occurrence awaiting final delivery admission. */
export interface ReminderDeliveryCandidate {
  phaseId: string;
  occurrenceKey: string;
  /** Present once a claim response carries its authoritative snapshot. */
  projectKey?: string;
}

export type ReminderDeliveryRejection =
  | "no-document"
  | "project-changed"
  | "phase-missing"
  | "phase-deleted"
  | "phase-archived"
  | "phase-inactive"
  | "reminder-missing"
  | "stale-occurrence"
  | "deletion-generation-changed"
  | "disposed"
  | "admission-failed";

export type ReminderDeliveryAdmission =
  | { status: "admit"; deletionGeneration: number }
  | { status: "reject"; reason: ReminderDeliveryRejection };

/**
 * Final-delivery admission against the latest authoritative document. A claim can
 * commit before a phase deletion and still resolve after that deletion snapshot was
 * adopted, so every awaited claim is rechecked here before anything is dispatched.
 */
export function admitReminderDelivery(
  document: NotesDocumentV3 | null | undefined,
  candidate: Pick<ReminderDeliveryCandidate, "phaseId" | "occurrenceKey">,
): ReminderDeliveryAdmission {
  if (!document) return { status: "reject", reason: "no-document" };
  const phase = document.phases.find((entry) => entry.id === candidate.phaseId);
  if (!phase) return { status: "reject", reason: "phase-missing" };
  if (!isNotesPhasePresent(phase)) return { status: "reject", reason: "phase-deleted" };
  if (phase.archivedAt !== null) return { status: "reject", reason: "phase-archived" };
  if (phase.status === "done" || phase.status === "cancelled") {
    return { status: "reject", reason: "phase-inactive" };
  }
  if (!phase.reminder) return { status: "reject", reason: "reminder-missing" };
  if (phase.reminder.occurrenceKey !== candidate.occurrenceKey) {
    return { status: "reject", reason: "stale-occurrence" };
  }
  return { status: "admit", deletionGeneration: notesPhaseDeletionGeneration(phase) };
}

/** Scoped identity carried to the native notification adapter alongside sound preference. */
export interface NativeReminderNotificationRequest {
  soundEnabled: boolean;
  projectKey: string;
  phaseId: string;
  occurrenceKey: string;
}

export interface RoadmapReminderDeliveryDependencies {
  client: Pick<NotesClient, "reserveReminder" | "claimReminder" | "releaseReminder">;
  onInApp(delivery: InAppReminderDelivery): void;
  notificationPermission(): Promise<NativeNotificationPermission>;
  showNativeNotification(request: NativeReminderNotificationRequest): Promise<void>;
  admitDelivery(candidate: ReminderDeliveryCandidate): ReminderDeliveryAdmission;
  soundEnabled(): boolean;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  logError(error: unknown): void;
}

let permissionRequest: Promise<NativeNotificationPermission> | null = null;

export class RoadmapReminderDeliveryHost {
  private readonly dependencies: RoadmapReminderDeliveryDependencies;
  private drainPromise: Promise<void> | null = null;
  private retryTimer: unknown | null = null;
  private latestFocused = true;
  private rerunRequested = false;
  private transportRetryCount = 0;
  private transportErrorLogged = false;
  private disposed = false;

  constructor(
    client: Pick<NotesClient, "reserveReminder" | "claimReminder" | "releaseReminder">,
    onInApp: (delivery: InAppReminderDelivery) => void,
    dependencies: Partial<Omit<RoadmapReminderDeliveryDependencies, "client" | "onInApp">> = {},
  ) {
    this.dependencies = {
      client,
      onInApp,
      notificationPermission: async () => {
        const permission = await invoke<unknown>("roadmap_reminder_notification_permission");
        return isNativeNotificationPermission(permission) ? permission : "unavailable";
      },
      showNativeNotification: (request) =>
        invoke("show_roadmap_reminder_notification", {
          soundEnabled: request.soundEnabled,
          projectKey: request.projectKey,
          phaseId: request.phaseId,
          occurrenceKey: request.occurrenceKey,
        }),
      admitDelivery: () => ({ status: "admit", deletionGeneration: 0 }),
      soundEnabled: isSoundEnabled,
      now: Date.now,
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      logError: (error) => {
        void Promise.resolve(logError(`roadmap reminder delivery failed: ${String(error)}`)).catch(
          () => undefined,
        );
      },
      ...dependencies,
    };
  }

  drain(focused: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.latestFocused = focused;
    this.cancelRetryTimer();
    this.resetTransportRetry();
    return this.enqueueDrain();
  }

  dispose(): void {
    this.disposed = true;
    this.rerunRequested = false;
    this.cancelRetryTimer();
  }

  private enqueueDrain(): Promise<void> {
    if (this.drainPromise) {
      this.rerunRequested = true;
      return this.drainPromise;
    }
    this.drainPromise = this.runScheduledDrains().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async runScheduledDrains(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.runDrain();
      if (this.rerunRequested) this.cancelRetryTimer();
    } while (this.rerunRequested && !this.disposed);
  }

  private async runDrain(): Promise<void> {
    for (let delivered = 0; delivered < 100 && !this.disposed; delivered += 1) {
      let reservation;
      try {
        reservation = await this.dependencies.client.reserveReminder(this.latestFocused);
      } catch (error) {
        this.scheduleTransportRetry(error);
        return;
      }
      if (this.disposed) return;
      if (reservation.status === "deferred") {
        this.resetTransportRetry();
        const delay = Math.max(0, Date.parse(reservation.retryAt) - this.dependencies.now());
        this.scheduleWake(delay);
        return;
      }
      if (reservation.status !== "reserved") {
        this.resetTransportRetry();
        return;
      }

      const candidate: ReminderDeliveryCandidate = {
        phaseId: reservation.phase.id,
        occurrenceKey: reservation.reminder.occurrenceKey,
      };
      const baseline = this.admit(candidate);
      if (baseline.status !== "admit") {
        await this.releaseReservation(reservation.leaseToken);
        this.resetTransportRetry();
        return;
      }

      let permission: NativeNotificationPermission | null = null;
      try {
        if (!this.latestFocused) {
          permission = await resolveNotificationPermission(this.dependencies);
        }
        if (this.disposed) {
          await this.releaseReservation(reservation.leaseToken);
          return;
        }

        let claim: ReminderClaimOutcome;
        let inAppDelivery = false;
        let nativeDelivery = false;
        if (this.latestFocused) {
          inAppDelivery = true;
          claim = await this.dependencies.client.claimReminder(
            reservation.leaseToken,
            "in-app",
            "not-required",
          );
        } else if (permission === "granted") {
          nativeDelivery = true;
          claim = await this.dependencies.client.claimReminder(
            reservation.leaseToken,
            "native",
            "granted",
          );
        } else {
          claim = await this.dependencies.client.claimReminder(
            reservation.leaseToken,
            "in-app-fallback",
            permission ?? "unavailable",
          );
        }

        if (claim.status !== "ok") {
          await this.releaseReservation(reservation.leaseToken);
          this.resetTransportRetry();
          return;
        }

        this.resetTransportRetry();

        // The claim committed durably before this response resolved, so the phase may
        // already be deleted, recovered, or replaced in the adopted snapshot. Recheck
        // final admission here; the occurrence stays consumed either way.
        if (this.disposed) return;
        const projectKey = claim.snapshot?.projectKey;
        const final = this.admit({ ...candidate, projectKey });
        if (final.status !== "admit" || final.deletionGeneration !== baseline.deletionGeneration) {
          continue;
        }

        if (inAppDelivery) {
          try {
            this.dependencies.onInApp({ ...reservation, snapshot: claim.snapshot });
          } catch (error) {
            this.dependencies.logError(error);
          }
        } else if (nativeDelivery) {
          if (typeof projectKey !== "string" || projectKey.length === 0) continue;
          try {
            await this.dependencies.showNativeNotification({
              soundEnabled: this.dependencies.soundEnabled(),
              projectKey,
              phaseId: candidate.phaseId,
              occurrenceKey: candidate.occurrenceKey,
            });
          } catch (error) {
            this.dependencies.logError(error);
          }
        }
      } catch (error) {
        await this.releaseReservation(reservation.leaseToken);
        this.scheduleTransportRetry(error);
        return;
      }
    }
  }

  /** Fail closed: an admission callback that throws must not dispatch a delivery. */
  private admit(candidate: ReminderDeliveryCandidate): ReminderDeliveryAdmission {
    if (this.disposed) return { status: "reject", reason: "disposed" };
    try {
      return this.dependencies.admitDelivery(candidate);
    } catch (error) {
      this.dependencies.logError(error);
      return { status: "reject", reason: "admission-failed" };
    }
  }

  private async releaseReservation(leaseToken: string): Promise<void> {
    await this.dependencies.client.releaseReminder(leaseToken).catch(() => undefined);
  }

  private scheduleTransportRetry(error: unknown): void {
    if (!this.transportErrorLogged) {
      this.transportErrorLogged = true;
      this.dependencies.logError(error);
    }
    if (this.disposed || this.transportRetryCount >= TRANSPORT_RETRY_LIMIT) return;
    const delay = TRANSPORT_RETRY_BASE_DELAY_MS * 2 ** this.transportRetryCount;
    this.transportRetryCount += 1;
    this.scheduleWake(delay);
  }

  private scheduleWake(delayMs: number): void {
    this.cancelRetryTimer();
    this.retryTimer = this.dependencies.setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed) void this.enqueueDrain();
    }, delayMs);
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== null) this.dependencies.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resetTransportRetry(): void {
    this.transportRetryCount = 0;
    this.transportErrorLogged = false;
  }
}

async function resolveNotificationPermission(
  dependencies: Pick<RoadmapReminderDeliveryDependencies, "notificationPermission" | "logError">,
): Promise<NativeNotificationPermission> {
  permissionRequest ??= dependencies
    .notificationPermission()
    .catch((error) => {
      dependencies.logError(error);
      return "unavailable" as const;
    })
    .finally(() => {
      permissionRequest = null;
    });
  return permissionRequest;
}

function isNativeNotificationPermission(value: unknown): value is NativeNotificationPermission {
  return value === "granted" || value === "denied" || value === "unavailable";
}

export function resetReminderPermissionCacheForTests(): void {
  permissionRequest = null;
}
