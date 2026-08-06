/**
 * Scheduling policy — every tunable number in one place.
 *
 * These are business rules, not implementation details. They live in the shared
 * package because the browser and the Cloud Function must apply the *same*
 * numbers: if the UI greys out slots using a 2-hour rule while the server
 * enforces 90 minutes, a parent gets an error on a slot the app just offered
 * them. That inconsistency is a support ticket, and it is entirely avoidable by
 * having exactly one definition.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Minimum notice for a reschedule: **2 hours**.
 *
 * This is a real tutoring lead-time policy, not an arbitrary guard. A teacher
 * needs time to see the change, prep different material, and rearrange their
 * day; a slot moved with twenty minutes' notice is a slot the teacher sits
 * through alone. Two hours is the shortest window where the teacher can
 * realistically still be told.
 */
export const RESCHEDULE_LEAD_TIME_MS = 2 * HOUR_MS;

/**
 * Slack allowed when comparing a slot against the server clock.
 *
 * The client greys out slots using ITS clock; the server validates using its
 * own. Between the two sits network latency, the user's thinking time, and
 * whatever drift the device has. Without a grace window, a parent who taps a
 * slot the instant it becomes legal gets rejected for being 300ms early — and
 * from their side the app just offered them a slot and then refused it.
 *
 * One minute is comfortably larger than latency plus normal drift, and far too
 * small to be worth gaming: the whole point of the policy is the teacher's
 * prep time, and 119 minutes is not materially worse than 120.
 */
export const CLOCK_SKEW_GRACE_MS = MINUTE_MS;

/** Slots are offered on the half hour. */
export const SLOT_GRANULARITY_MINUTES = 30;

/** Earliest hour a session may start, in the parent's local wall clock. */
export const BOOKING_DAY_START_HOUR = 8;

/**
 * Latest hour a session may *start*, local wall clock. Exclusive — with a
 * 21 here, the last offered slot is 20:30.
 */
export const BOOKING_DAY_END_HOUR = 21;

/**
 * How far ahead a parent may reschedule. Beyond this the teacher's roster
 * isn't published yet, so accepting the request would be a promise we can't
 * keep.
 */
export const BOOKING_HORIZON_DAYS = 60;

/** Max length of the free-text note attached to a request. */
export const NOTE_MAX_LENGTH = 300;

/** Statuses a parent is allowed to request a reschedule against. */
export const RESCHEDULABLE_STATUSES = ["confirmed", "reschedule_requested"] as const;

/** Human-readable summary, used in UI copy so the wording tracks the constant. */
export const LEAD_TIME_LABEL = `${RESCHEDULE_LEAD_TIME_MS / HOUR_MS} hours`;
