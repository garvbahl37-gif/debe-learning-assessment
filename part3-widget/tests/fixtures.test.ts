/**
 * The mock fixtures.
 *
 * Fixture data is not usually worth testing. This is, because the whole demo
 * rests on it looking like a real schedule at whatever hour someone opens the
 * page — and the first version didn't.
 */

import { describe, expect, it } from "vitest";

import {
  BOOKING_DAY_END_HOUR,
  BOOKING_DAY_START_HOUR,
  utcToWallClock,
} from "@debe/shared";
import { MOCK_PARENT, materialiseSessions } from "@debe/shared/mock";

const ZONE = MOCK_PARENT.timeZone;

/** Every hour of one day, so no opening time is left untested. */
const HOURLY_THROUGH_A_DAY = Array.from({ length: 24 }, (_, hour) =>
  Date.parse(`2026-08-08T${String(hour).padStart(2, "0")}:17:00.000Z`),
);

describe("materialiseSessions", () => {
  it.each(HOURLY_THROUGH_A_DAY)(
    "lands every session inside the tutoring day, opened at %i",
    (nowMs) => {
      for (const session of materialiseSessions(nowMs, ZONE)) {
        const reading = utcToWallClock(session.startsAtUtc, ZONE);
        const hour = Number(reading.slice(11, 13));
        const minute = Number(reading.slice(14, 16));

        // This is the assertion that would have caught the 00:30 maths lesson.
        expect(hour).toBeGreaterThanOrEqual(BOOKING_DAY_START_HOUR);
        expect(hour).toBeLessThan(BOOKING_DAY_END_HOUR);
        // …and on the half-hour grid the picker actually offers.
        expect([0, 30]).toContain(minute);
      }
    },
  );

  it("keeps every session in the future and in order", () => {
    const nowMs = Date.parse("2026-08-08T18:00:00.000Z"); // 23:30 Kolkata
    const sessions = materialiseSessions(nowMs, ZONE);
    const times = sessions.map((s) => new Date(s.startsAtUtc).getTime());

    expect(times.every((t) => t > nowMs)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("respects a zone with a three-quarter-hour offset", () => {
    // Kathmandu is +05:45. Snapping on the UTC grid would put these on :15 and
    // :45 locally — the exact bug the local-clock snap exists to avoid.
    for (const session of materialiseSessions(
      Date.parse("2026-08-08T09:23:00.000Z"),
      "Asia/Kathmandu",
    )) {
      const minute = Number(
        utcToWallClock(session.startsAtUtc, "Asia/Kathmandu").slice(14, 16),
      );
      expect([0, 30]).toContain(minute);
    }
  });
});
