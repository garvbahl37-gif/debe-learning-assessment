/**
 * Mock persistence.
 *
 * Reached through `@debe/shared/mock`, a separate entrypoint from the contract
 * in `@debe/shared`. That separation is the point: nothing in the real contract
 * can accidentally depend on fixture data, and swapping this for Firestore
 * means implementing one interface — `SessionRepository` — and deleting this
 * file.
 *
 * ── Why the fixture stores no dates ─────────────────────────────────────────
 *
 * `sessions.json` holds `earliestInHours` and a habitual `localTime`, never
 * `2026-08-08T13:00:00Z`. A fixture with absolute dates is a demo with a shelf
 * life: it looks right the week you write it and shows four sessions in the
 * past by the time anyone opens it.
 *
 * The pair also keeps the schedule plausible. An offset alone put a Year 9
 * maths lesson at 00:30 when the portal was opened at midnight; snapping every
 * offset into the tutoring day then put all four at 08:00, which is no more
 * convincing. Naming the hour each lesson habitually runs at — see
 * `nextLocalOccurrence` — is what a real timetable actually looks like.
 */

import {
  addDaysToLocalDate,
  localDateInZone,
  toUtcIso,
  wallClockToUtc,
} from "../time";
import type {
  ParentProfile,
  RescheduleRequest,
  TimeZoneId,
  TutoringSession,
} from "../types";
import type { SessionRepository } from "../handler";
import fixtures from "./sessions.json";

/** The signed-in parent. In production this comes from the auth token. */
export const MOCK_PARENT: ParentProfile = {
  id: "par_9931",
  name: "Priya Raghunathan",
  // The zone stored on the account. The server renders in this zone so its
  // HTML matches the client's first paint exactly — see the note in
  // `types.ts` on `ParentProfile.timeZone`.
  timeZone: "Asia/Kolkata",
};

interface SessionFixture {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly subject: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly earliestInHours: number;
  readonly localTime: string;
  readonly durationMinutes: number;
  readonly status: string;
}

/**
 * The next time the family's clock reads `localTime`, at or after `earliestMs`.
 *
 * Real tutoring schedules are habitual — the same child has maths at four on a
 * Friday, week after week. So each fixture names the hour it happens at, and
 * this walks forward to the next occurrence of it. Two things follow: the
 * schedule looks like a schedule rather than four lessons all at 08:00, and it
 * reads sensibly whatever time of day the page is opened.
 *
 * Note this resolves against the **local** wall clock, not by adding
 * milliseconds. Adding 24 hours of elapsed time to a recurring appointment
 * walks it off its own hour across a DST boundary — "four o'clock on Fridays"
 * becomes five o'clock for half the year. Resolving the reading fresh each day
 * is the same reason the slot generator iterates wall clocks.
 */
function nextLocalOccurrence(
  earliestMs: number,
  localTime: string,
  timeZone: TimeZoneId,
): number {
  let localDate = localDateInZone(earliestMs, timeZone);

  // A fortnight is far more than enough; the guard is only here so a bad
  // fixture can never spin forever.
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const conversion = wallClockToUtc(`${localDate}T${localTime}`, timeZone);
    const candidateMs = new Date(conversion.utc).getTime();
    if (candidateMs >= earliestMs) return candidateMs;
    localDate = addDaysToLocalDate(localDate, 1);
  }

  throw new Error(
    `Fixture ${localTime} in ${timeZone} found no slot within a fortnight.`,
  );
}

/**
 * Turn the fixtures into real sessions at real instants.
 *
 * `earliestInHours` is the minimum lead; `localTime` is the hour the lesson
 * habitually runs at. Together they place each session at the next plausible
 * occurrence, in the family's own timezone.
 */
export function materialiseSessions(
  nowMs: number,
  timeZone: TimeZoneId = MOCK_PARENT.timeZone,
): TutoringSession[] {
  return (fixtures as readonly SessionFixture[]).map((fixture) => {
    const earliest = nowMs + fixture.earliestInHours * 3_600_000;
    const startsAt = nextLocalOccurrence(earliest, fixture.localTime, timeZone);

    return {
      id: fixture.id,
      studentId: fixture.studentId,
      studentName: fixture.studentName,
      subject: fixture.subject,
      teacherId: fixture.teacherId,
      teacherName: fixture.teacherName,
      startsAtUtc: toUtcIso(startsAt),
      durationMinutes: fixture.durationMinutes,
      status: fixture.status as TutoringSession["status"],
    };
  });
}

export interface SessionStore extends SessionRepository {
  /** The parent's upcoming sessions, soonest first. */
  listUpcoming(parentId: string, nowMs: number, limit: number): TutoringSession[];
  /** Test helper — drop everything and re-materialise from the fixture. */
  reset(nowMs: number): void;
}

/**
 * Which parent owns which student. In production this is a Firestore lookup on
 * the guardian relationship; a parent may have several children, and a child
 * may have two guardians. Modelled explicitly rather than assumed, because
 * "the parent id equals the student id" is the kind of shortcut that becomes
 * an authorisation hole the day a second child is added.
 */
const GUARDIAN_OF: Readonly<Record<string, readonly string[]>> = {
  [MOCK_PARENT.id]: ["stu_arjun"],
};

function isGuardian(parentId: string, studentId: string): boolean {
  return GUARDIAN_OF[parentId]?.includes(studentId) ?? false;
}

export function createSessionStore(nowMs: number): SessionStore {
  let sessions = materialiseSessions(nowMs);

  return {
    listUpcoming(parentId, now, limit) {
      return sessions
        .filter(
          (session) =>
            isGuardian(parentId, session.studentId) &&
            new Date(session.startsAtUtc).getTime() > now &&
            session.status !== "cancelled" &&
            session.status !== "completed",
        )
        .sort(
          (a, b) =>
            new Date(a.startsAtUtc).getTime() -
            new Date(b.startsAtUtc).getTime(),
        )
        .slice(0, limit);
    },

    async findForParent(sessionId, parentId) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return null;
      // Ownership is part of the lookup, not a check the caller might forget.
      // Returns null for "not yours" as well as "no such session", so the
      // endpoint can't be used to probe which session ids exist.
      if (!isGuardian(parentId, session.studentId)) return null;
      return session;
    },

    async applyRescheduleRequest({ session, request }) {
      // A real implementation writes the request to a `rescheduleRequests`
      // collection and flips the session's status inside a transaction, so the
      // audit row and the status change land together or not at all. Here it
      // is one array swap, but the shape is the same: the session moves to
      // `reschedule_requested` rather than silently changing time, because a
      // tutor has to agree before the slot is actually theirs.
      const updated: TutoringSession = {
        ...session,
        startsAtUtc: request.newSlotUtc,
        status: "reschedule_requested",
      };
      sessions = sessions.map((candidate) =>
        candidate.id === session.id ? updated : candidate,
      );
      return updated;
    },

    reset(now) {
      sessions = materialiseSessions(now);
    },
  };
}

/**
 * One store per Node process.
 *
 * Pinned to `globalThis` because Next's dev server re-evaluates modules on
 * every hot reload — without this, a reschedule would appear to work and then
 * vanish the next time you saved a file, which is a confusing five minutes to
 * spend debugging something that isn't broken.
 */
const STORE_KEY = Symbol.for("debe.sessionStore");

type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: SessionStore };

export function getSessionStore(): SessionStore {
  const scope = globalThis as GlobalWithStore;
  scope[STORE_KEY] ??= createSessionStore(Date.now());
  return scope[STORE_KEY];
}
