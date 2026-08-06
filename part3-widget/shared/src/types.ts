/**
 * The contract shared by the browser and the Cloud Function.
 *
 * This file is imported by BOTH `web/` and `functions/` through the
 * `@debe/shared` workspace package. That is deliberate: the brief asks for
 * "shared types between frontend and function", and the only way to guarantee
 * they cannot drift is to make them literally the same file rather than two
 * copies that agree today.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Branded time strings
//
// The single most common bug in scheduling code is passing a wall-clock string
// where an instant was expected — they are both `string`, so the compiler waves
// it through and the error only shows up as an off-by-N-hours booking for the
// one user in a different timezone.
//
// Branding makes those two things different types. You cannot hand a
// `<input type="datetime-local">` value to something that wants a stored
// instant without going through `wallClockToUtc()`, which is exactly the
// conversion that must never be skipped. It costs nothing at runtime — the
// brand is erased — and it turns a whole class of production bug into a red
// squiggle.
// ─────────────────────────────────────────────────────────────────────────────

declare const utcIsoBrand: unique symbol;
declare const wallClockBrand: unique symbol;

/**
 * An absolute instant, serialised as canonical UTC ISO-8601 with milliseconds
 * and a trailing `Z` — e.g. `2026-08-08T09:30:00.000Z`.
 *
 * This is the ONLY form in which a time is ever stored or transmitted.
 * Construct one with `toUtcIso()` or `wallClockToUtc()`; never by casting.
 */
export type UtcIsoString = string & { readonly [utcIsoBrand]: "UtcIsoString" };

/**
 * A wall-clock reading with NO timezone attached — `2026-08-08T15:00`, exactly
 * what `<input type="datetime-local">` gives you.
 *
 * It is not a point in time. "3pm on the 8th" is a different instant in Mumbai
 * than in London, and on a DST boundary it can be an instant that occurs twice,
 * or one that never occurs at all. It only becomes an instant once you pair it
 * with an IANA timezone.
 */
export type LocalWallClock = string & {
  readonly [wallClockBrand]: "LocalWallClock";
};

/** An IANA timezone identifier, e.g. `Asia/Kolkata`, `Europe/London`. */
export type TimeZoneId = string;

// ─────────────────────────────────────────────────────────────────────────────
// Domain
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  "confirmed",
  "reschedule_requested",
  "completed",
  "cancelled",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * A tutoring session as the portal stores it.
 *
 * `startsAtUtc` is an instant. There is no `timeZone` field on a session on
 * purpose: the session does not happen "at 3pm", it happens at an instant, and
 * the parent, the student and the teacher may each be looking at that instant
 * from a different zone. Rendering is a presentation concern, decided per
 * viewer — see `formatInZone()`.
 */
export interface TutoringSession {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly subject: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly startsAtUtc: UtcIsoString;
  readonly durationMinutes: number;
  readonly status: SessionStatus;
}

export const RESCHEDULE_REASONS = [
  "conflict",
  "illness",
  "timezone",
  "other",
] as const;

export type RescheduleReason = (typeof RESCHEDULE_REASONS)[number];

export const RESCHEDULE_REASON_LABELS: Readonly<
  Record<RescheduleReason, string>
> = {
  conflict: "Conflict",
  illness: "Illness",
  timezone: "Time zone",
  other: "Other",
};

/**
 * What the browser sends to `requestReschedule`.
 *
 * Note what is NOT here: no `studentId`, no `parentId`. Identity comes from the
 * verified auth token on the server, never from the payload — the same lesson
 * as bug 2 in Part 2. A parent who could name the student in the body could
 * reschedule another family's session.
 */
export interface RescheduleRequest {
  readonly sessionId: string;
  /** The requested new start, already converted to UTC by the client. */
  readonly newSlotUtc: UtcIsoString;
  readonly reason: RescheduleReason;
  /** Free text. Required when `reason` is `other`. */
  readonly note?: string;
  /**
   * The zone the parent was actually looking at when they picked.
   *
   * Not used for validation — the server re-derives everything from the UTC
   * instant. It is stored for support: when a parent says "I booked 3pm and it
   * shows 8:30pm", this field is the difference between a five-minute answer
   * and an afternoon of guessing.
   */
  readonly requestedFromTimeZone: TimeZoneId;
}

export type RescheduleErrorCode =
  | "unauthenticated"
  | "invalid-argument"
  | "not-found"
  | "session-not-reschedulable"
  | "slot-unchanged"
  | "slot-in-past"
  | "lead-time-violation"
  | "slot-outside-booking-window"
  | "internal";

/**
 * The brief specifies `{ success: boolean; error?: string }`. This is that,
 * narrowed into a discriminated union: a caller cannot read `error` off a
 * success, and we cannot return a failure without saying why. The
 * `_ContractCheck` below is a compile-time proof that the union is still
 * assignable to the shape the brief asked for.
 */
export type RescheduleResponse =
  | {
      readonly success: true;
      readonly session: TutoringSession;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: RescheduleErrorCode;
    };

/** Fails to compile if `RescheduleResponse` ever stops matching the brief. */
type _ContractCheck = RescheduleResponse extends {
  success: boolean;
  error?: string;
}
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _contractHolds: _ContractCheck = true;

/** The parent viewing the portal. */
export interface ParentProfile {
  readonly id: string;
  readonly name: string;
  /**
   * The zone stored on the parent's account.
   *
   * The server renders in THIS zone, so server and client produce identical
   * HTML and there is no hydration mismatch. The browser's detected zone is
   * then compared against it on the client — see `TimeZoneNotice`.
   */
  readonly timeZone: TimeZoneId;
}
