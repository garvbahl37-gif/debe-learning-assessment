/**
 * `requestReschedule`, end to end through the shared handler.
 *
 * No emulator, no Firebase project, no network. The handler takes a repository
 * and a clock, so the entire rule set — including the authorisation rules,
 * which are the ones worth being sure about — is exercised by plain functions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRescheduleHandler,
  toUtcIso,
  type RescheduleHandler,
  type SessionRepository,
  type TutoringSession,
} from "@debe/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const NOW = Date.parse("2026-08-08T06:00:00.000Z");

const PARENT = "par_9931";
const OTHER_PARENT = "par_0002";

function makeSession(overrides: Partial<TutoringSession> = {}): TutoringSession {
  return {
    id: "ses_4f21a",
    studentId: "stu_arjun",
    studentName: "Arjun",
    subject: "Mathematics — Year 9",
    teacherId: "tea_okafor",
    teacherName: "Chidinma Okafor",
    startsAtUtc: toUtcIso(NOW + 30 * HOUR),
    durationMinutes: 60,
    status: "confirmed",
    ...overrides,
  };
}

/**
 * A repository that only ever returns the session to its own parent.
 *
 * Mirrors the real contract: ownership is part of the lookup, and "not yours"
 * is indistinguishable from "does not exist".
 */
function makeRepository(session: TutoringSession, ownerId = PARENT) {
  const applied: unknown[] = [];
  const repository: SessionRepository = {
    async findForParent(sessionId, parentId) {
      if (sessionId !== session.id || parentId !== ownerId) return null;
      return session;
    },
    async applyRescheduleRequest(args) {
      applied.push(args);
      return {
        ...args.session,
        startsAtUtc: args.request.newSlotUtc,
        status: "reschedule_requested",
      };
    },
  };
  return { repository, applied };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_4f21a",
    newSlotUtc: toUtcIso(NOW + 48 * HOUR),
    reason: "conflict",
    requestedFromTimeZone: "Asia/Kolkata",
    ...overrides,
  };
}

describe("requestReschedule", () => {
  let handler: RescheduleHandler;
  let applied: unknown[];
  let session: TutoringSession;

  beforeEach(() => {
    session = makeSession();
    const repo = makeRepository(session);
    applied = repo.applied;
    handler = createRescheduleHandler({
      repository: repo.repository,
      now: () => NOW,
    });
  });

  describe("authentication and authorisation", () => {
    it("refuses an unauthenticated caller", async () => {
      const result = await handler(validPayload(), null);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("unauthenticated");
      expect(applied).toHaveLength(0);
    });

    it("checks auth before it even looks at the payload", async () => {
      // Order matters: an unauthenticated caller must not be able to use
      // validation error messages to probe what the endpoint accepts.
      const result = await handler({ garbage: true }, null);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("unauthenticated");
    });

    it("will not let one parent touch another family's session", async () => {
      // The IDOR case, and the direct descendant of bug 2 in Part 2. A
      // perfectly valid, perfectly authenticated request — for somebody else's
      // child.
      const result = await handler(validPayload(), { uid: OTHER_PARENT });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("not-found");
      expect(applied).toHaveLength(0);
    });

    it("gives the same answer for someone else's session as for one that does not exist", async () => {
      // If these differed, the endpoint would confirm which session ids are
      // real to anyone willing to enumerate.
      const notMine = await handler(validPayload(), { uid: OTHER_PARENT });
      const notReal = await handler(
        validPayload({ sessionId: "ses_does_not_exist" }),
        { uid: PARENT },
      );

      expect(notMine).toEqual(notReal);
    });

    it("ignores any identity the client puts in the body", async () => {
      // Belt and braces: even if a caller invents `parentId` / `studentId`
      // fields, they are not read. Identity comes from the verified token.
      const result = await handler(
        validPayload({ parentId: OTHER_PARENT, studentId: "stu_someone_else" }),
        { uid: PARENT },
      );

      expect(result.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it.each([
      ["a non-object body", "nope"],
      ["an array", []],
      ["null", null],
    ])("rejects %s", async (_label, payload) => {
      const result = await handler(payload, { uid: PARENT });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("invalid-argument");
    });

    it("rejects a slot string with no UTC offset", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: "2026-08-10T15:00:00" }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("invalid-argument");
      expect(result.error).toMatch(/offset/i);
    });

    it("rejects a reason outside the allowed set", async () => {
      const result = await handler(validPayload({ reason: "just because" }), {
        uid: PARENT,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("invalid-argument");
    });

    it("requires a note when the reason is Other", async () => {
      const result = await handler(
        validPayload({ reason: "other", note: "   " }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.error).toMatch(/Other/);
    });

    it("accepts Other once a note is supplied", async () => {
      const result = await handler(
        validPayload({ reason: "other", note: "School trip" }),
        { uid: PARENT },
      );

      expect(result.success).toBe(true);
    });

    it("rejects an invalid IANA timezone", async () => {
      const result = await handler(
        validPayload({ requestedFromTimeZone: "Mars/Olympus_Mons" }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
    });
  });

  describe("the business rules the brief names", () => {
    it("rejects a slot identical to the one already booked", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: session.startsAtUtc }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("slot-unchanged");
    });

    it("recognises the existing slot even when written in another form", async () => {
      // Same instant, serialised with a +05:30 offset instead of Z. A raw
      // string comparison would call these different and happily "reschedule"
      // the session to the time it is already at.
      const asOffset = new Date(session.startsAtUtc)
        .toISOString()
        .replace("Z", "+00:00");

      const result = await handler(validPayload({ newSlotUtc: asOffset }), {
        uid: PARENT,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("slot-unchanged");
    });

    it("rejects a slot in the past", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: toUtcIso(NOW - 3 * HOUR) }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("slot-in-past");
    });

    it("rejects a slot inside the 2-hour lead time", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: toUtcIso(NOW + 90 * MINUTE) }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("lead-time-violation");
      expect(result.error).toMatch(/2 hours/);
    });

    it("accepts a slot exactly on the lead-time boundary", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: toUtcIso(NOW + 2 * HOUR) }),
        { uid: PARENT },
      );

      expect(result.success).toBe(true);
    });

    it("enforces lead time against the SERVER clock, not the client's", async () => {
      // A browser with a wrong system clock — or a crafted request — would
      // have greyed nothing out. The server does not care what the client
      // believes the time is; it never receives a client timestamp at all.
      const serverThinksItIsLater = createRescheduleHandler({
        repository: makeRepository(session).repository,
        now: () => NOW + 47 * HOUR,
      });

      const result = await serverThinksItIsLater(
        validPayload({ newSlotUtc: toUtcIso(NOW + 48 * HOUR) }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("lead-time-violation");
    });

    it("rejects a slot beyond the published booking horizon", async () => {
      const result = await handler(
        validPayload({ newSlotUtc: toUtcIso(NOW + 400 * 24 * HOUR) }),
        { uid: PARENT },
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("slot-outside-booking-window");
    });

    it.each([
      ["cancelled", /cancelled/i],
      ["completed", /already taken place/i],
    ] as const)("refuses to reschedule a %s session", async (status, message) => {
      const repo = makeRepository(makeSession({ status }));
      const scoped = createRescheduleHandler({
        repository: repo.repository,
        now: () => NOW,
      });

      const result = await scoped(validPayload(), { uid: PARENT });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("session-not-reschedulable");
      expect(result.error).toMatch(message);
    });
  });

  describe("the happy path", () => {
    it("returns the updated session and marks it as requested", async () => {
      const newSlotUtc = toUtcIso(NOW + 48 * HOUR);
      const result = await handler(validPayload({ newSlotUtc }), { uid: PARENT });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("narrowing");
      expect(result.session.startsAtUtc).toBe(newSlotUtc);
      // Not "confirmed" — a tutor has to agree before the slot is really theirs.
      expect(result.session.status).toBe("reschedule_requested");
    });

    it("canonicalises the slot before storing it", async () => {
      await handler(
        validPayload({ newSlotUtc: "2026-08-10T15:00:00+05:30" }),
        { uid: PARENT },
      );

      expect(applied).toHaveLength(1);
      expect(
        (applied[0] as { request: { newSlotUtc: string } }).request.newSlotUtc,
      ).toBe("2026-08-10T09:30:00.000Z");
    });

    it("attributes the request to the authenticated caller", async () => {
      await handler(validPayload(), { uid: PARENT });

      expect(
        (applied[0] as { requestedByParentId: string }).requestedByParentId,
      ).toBe(PARENT);
    });
  });

  describe("failure handling", () => {
    it("turns a storage failure into a generic message and logs the detail", async () => {
      const error = vi.fn();
      const exploding = createRescheduleHandler({
        repository: {
          async findForParent() {
            throw new Error("FIRESTORE: permission denied on /bookings/ses_4f21a");
          },
          async applyRescheduleRequest() {
            throw new Error("unreachable");
          },
        },
        now: () => NOW,
        logger: { error },
      });

      const result = await exploding(validPayload(), { uid: PARENT });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("narrowing");
      expect(result.code).toBe("internal");

      // The document path must not reach the client…
      expect(result.error).not.toMatch(/bookings/);
      expect(result.error).not.toMatch(/FIRESTORE/);
      // …but it must reach the logs, or the incident is undebuggable.
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.stringify(error.mock.calls[0])).toMatch(/permission denied/);
    });

    it("never rejects, whatever it is given", async () => {
      // The handler resolving for every outcome is what lets the UI drop its
      // try/catch, so it is worth asserting rather than assuming.
      const inputs: unknown[] = [
        undefined,
        null,
        0,
        "",
        [],
        { sessionId: 1 },
        Symbol("nope"),
      ];

      for (const input of inputs) {
        await expect(handler(input, { uid: PARENT })).resolves.toMatchObject({
          success: false,
        });
      }
    });
  });
});
