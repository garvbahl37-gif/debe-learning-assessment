/**
 * The reschedule validator.
 *
 * Pure: no clock, no network, no Firestore. `nowMs` and the session are passed
 * in, so the whole rule set is exercised by a plain unit test with no fake
 * timers and no emulator — see `tests/validateReschedule.test.ts`.
 *
 * ── Why this lives in `shared/` and not in `functions/` ─────────────────────
 *
 * The UI needs these rules to grey out slots before the parent picks; the
 * server needs them to enforce after. Two implementations of "2 hours" will
 * eventually disagree, and the failure looks like the app offering a slot and
 * then refusing it. One implementation, imported twice.
 *
 * That does NOT make the client check a substitute for the server one. The
 * client's copy is a courtesy — it stops the parent wasting a round trip. The
 * server runs the identical function against its own clock and its own copy of
 * the session, because the client's clock is attacker-controlled and can simply
 * be wrong. `handler.ts` calls this on every request regardless of what the
 * browser already decided.
 */

import {
  BOOKING_HORIZON_DAYS,
  LEAD_TIME_LABEL,
  NOTE_MAX_LENGTH,
  RESCHEDULABLE_STATUSES,
} from "./policy";
import { isInPast, satisfiesLeadTime } from "./slots";
import { isValidTimeZone, toUtcIso, TimeParseError } from "./time";
import {
  RESCHEDULE_REASONS,
  type RescheduleErrorCode,
  type RescheduleReason,
  type RescheduleRequest,
  type TutoringSession,
  type UtcIsoString,
} from "./types";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: RescheduleErrorCode;
      readonly error: string;
    };

const fail = (
  code: RescheduleErrorCode,
  error: string,
): ValidationResult<never> => ({ ok: false, code, error });

const DAY_MS = 86_400_000;

/**
 * Narrow untrusted input into a `RescheduleRequest`.
 *
 * Takes `unknown`, not `RescheduleRequest`. Anything arriving over the wire is
 * `unknown` no matter what the type annotation claims — TypeScript is erased at
 * runtime, so an annotation on a request body is a comment with extra steps.
 * (Bug 4 in Part 2, in its natural habitat.) This guard is the only place a
 * `RescheduleRequest` can come into existence, so past this point the static
 * type is actually true.
 */
export function parseRescheduleRequest(
  input: unknown,
): ValidationResult<RescheduleRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("invalid-argument", "Request body must be a JSON object.");
  }

  const { sessionId, newSlotUtc, reason, note, requestedFromTimeZone } =
    input as Record<string, unknown>;

  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return fail("invalid-argument", "A session must be identified.");
  }

  if (typeof newSlotUtc !== "string") {
    return fail("invalid-argument", "A new time is required.");
  }

  let canonicalSlot: UtcIsoString;
  try {
    // Canonicalising here means every comparison downstream — "is this the same
    // slot?", "is it in the past?" — is comparing like with like. Accepting
    // `+05:30` and `Z` forms and normalising both is more forgiving than
    // demanding one format, and safer than string-comparing whatever arrives.
    canonicalSlot = toUtcIso(newSlotUtc);
  } catch (error) {
    return fail(
      "invalid-argument",
      error instanceof TimeParseError
        ? error.message
        : "The new time is not a valid instant.",
    );
  }

  if (!isRescheduleReason(reason)) {
    return fail(
      "invalid-argument",
      `Reason must be one of: ${RESCHEDULE_REASONS.join(", ")}.`,
    );
  }

  if (note !== undefined && typeof note !== "string") {
    return fail("invalid-argument", "Note must be text.");
  }
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (trimmedNote.length > NOTE_MAX_LENGTH) {
    return fail(
      "invalid-argument",
      `Note must be ${NOTE_MAX_LENGTH} characters or fewer.`,
    );
  }
  // "Other" without an explanation gives the ops team a row they cannot act on.
  // Cheaper to insist here than to chase the parent by email later.
  if (reason === "other" && trimmedNote === "") {
    return fail(
      "invalid-argument",
      "Please tell us the reason when choosing “Other”.",
    );
  }

  if (
    typeof requestedFromTimeZone !== "string" ||
    !isValidTimeZone(requestedFromTimeZone)
  ) {
    return fail("invalid-argument", "A valid IANA timezone is required.");
  }

  return {
    ok: true,
    value: {
      sessionId: sessionId.trim(),
      newSlotUtc: canonicalSlot,
      reason,
      ...(trimmedNote === "" ? {} : { note: trimmedNote }),
      requestedFromTimeZone,
    },
  };
}

function isRescheduleReason(value: unknown): value is RescheduleReason {
  return (
    typeof value === "string" &&
    (RESCHEDULE_REASONS as readonly string[]).includes(value)
  );
}

export interface ValidateAgainstSessionArgs {
  readonly request: RescheduleRequest;
  /** `null` when the session does not exist, or is not this parent's. */
  readonly session: TutoringSession | null;
  /** The **server's** clock. Never the client's. */
  readonly nowMs: number;
}

/**
 * Apply the business rules to a parsed request.
 *
 * Order is deliberate — the first rule that fires produces the message the
 * parent sees, so the most specific and most actionable checks come first. "You
 * already have that time" is more useful than "too soon", and both are more
 * useful than a generic rejection.
 */
export function validateAgainstSession({
  request,
  session,
  nowMs,
}: ValidateAgainstSessionArgs): ValidationResult<RescheduleRequest> {
  if (!session) {
    // Deliberately the same answer for "does not exist" and "belongs to another
    // family". Distinguishing them turns this endpoint into an oracle that
    // confirms which session ids are real.
    return fail("not-found", "We couldn’t find that session.");
  }

  if (
    !(RESCHEDULABLE_STATUSES as readonly string[]).includes(session.status)
  ) {
    return fail(
      "session-not-reschedulable",
      session.status === "cancelled"
        ? "That session has been cancelled."
        : "That session has already taken place.",
    );
  }

  // Brief requirement 1: the new slot must not be identical to the existing one.
  // Both sides are canonical UTC by now, so this compares instants, not the
  // strings two different clients happened to serialise.
  if (request.newSlotUtc === session.startsAtUtc) {
    return fail(
      "slot-unchanged",
      "That’s the time the session is already booked for.",
    );
  }

  // Brief requirement 2: the new slot must not be in the past.
  if (isInPast(request.newSlotUtc, nowMs)) {
    return fail("slot-in-past", "That time has already passed.");
  }

  // The lead-time policy. Checked server-side against the SERVER clock — the
  // browser greys these out already, but a browser can lie, and a browser with
  // a wrong system clock does so by accident.
  if (!satisfiesLeadTime(request.newSlotUtc, nowMs)) {
    return fail(
      "lead-time-violation",
      `Reschedules need at least ${LEAD_TIME_LABEL}’ notice so your tutor can prepare.`,
    );
  }

  if (
    new Date(request.newSlotUtc).getTime() >
    nowMs + BOOKING_HORIZON_DAYS * DAY_MS
  ) {
    return fail(
      "slot-outside-booking-window",
      `Tutor availability is only published ${BOOKING_HORIZON_DAYS} days ahead.`,
    );
  }

  return { ok: true, value: request };
}
