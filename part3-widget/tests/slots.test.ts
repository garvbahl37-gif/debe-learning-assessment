/**
 * The 2-hour lead-time lock-out, and slot generation across DST.
 */

import { describe, expect, it } from "vitest";

import {
  BOOKING_DAY_END_HOUR,
  BOOKING_DAY_START_HOUR,
  CLOCK_SKEW_GRACE_MS,
  RESCHEDULE_LEAD_TIME_MS,
  SLOT_GRANULARITY_MINUTES,
  earliestBookableUtc,
  generateDaySlots,
  isInPast,
  satisfiesLeadTime,
  toUtcIso,
} from "@debe/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fixed "now" so nothing here depends on when the suite runs. */
const NOW = Date.parse("2026-08-08T06:00:00.000Z"); // 11:30 in Kolkata

describe("the lead-time policy", () => {
  it("is two hours", () => {
    // Pinned deliberately. If someone changes the constant, this test tells
    // them they have changed a *business rule* and should have said so.
    expect(RESCHEDULE_LEAD_TIME_MS).toBe(2 * HOUR);
  });

  it("accepts a slot exactly on the boundary", () => {
    expect(satisfiesLeadTime(toUtcIso(NOW + 2 * HOUR), NOW)).toBe(true);
  });

  it("accepts a slot comfortably beyond it", () => {
    expect(satisfiesLeadTime(toUtcIso(NOW + 3 * HOUR), NOW)).toBe(true);
  });

  it("rejects a slot inside the window", () => {
    expect(satisfiesLeadTime(toUtcIso(NOW + 90 * MINUTE), NOW)).toBe(false);
  });

  it("rejects a slot one minute inside the window, past the grace", () => {
    // The grace is one minute, so 2h − 2min must still fail. Without this the
    // grace could quietly grow and nobody would notice.
    expect(
      satisfiesLeadTime(toUtcIso(NOW + 2 * HOUR - 2 * MINUTE), NOW),
    ).toBe(false);
  });

  it("admits a slot a few seconds inside the window, via the skew grace", () => {
    // A parent who taps the instant a slot becomes legal should not be refused
    // because their request spent 300ms in flight. The grace only ever admits.
    expect(
      satisfiesLeadTime(toUtcIso(NOW + 2 * HOUR - 30_000), NOW),
    ).toBe(true);
    expect(CLOCK_SKEW_GRACE_MS).toBe(MINUTE);
  });

  it("exposes the boundary as an instant", () => {
    expect(earliestBookableUtc(NOW)).toBe("2026-08-08T08:00:00.000Z");
  });
});

describe("isInPast", () => {
  it("is true for a slot before now", () => {
    expect(isInPast(toUtcIso(NOW - HOUR), NOW)).toBe(true);
  });

  it("is false for a slot after now", () => {
    expect(isInPast(toUtcIso(NOW + HOUR), NOW)).toBe(false);
  });
});

describe("generateDaySlots", () => {
  const zone = "Asia/Kolkata";

  it("covers the booking day on the configured grid", () => {
    const slots = generateDaySlots({
      localDate: "2026-08-20", // well clear of `NOW`, so nothing is blocked
      timeZone: zone,
      nowMs: NOW,
    });

    const expectedCount =
      ((BOOKING_DAY_END_HOUR - BOOKING_DAY_START_HOUR) * 60) /
      SLOT_GRANULARITY_MINUTES;

    expect(slots).toHaveLength(expectedCount);
    expect(slots[0]?.label).toBe("08:00");
    expect(slots.at(-1)?.label).toBe("20:30");
    expect(slots.every((slot) => slot.selectable)).toBe(true);
  });

  it("blocks exactly the slots inside the 2-hour window, and nothing beyond", () => {
    // NOW is 11:30 Kolkata, so the boundary is 13:30. 08:00–11:00 are past,
    // 11:30, 12:00, 12:30 and 13:00 are inside the window, 13:30 onwards is
    // free.
    const slots = generateDaySlots({
      localDate: "2026-08-08",
      timeZone: zone,
      nowMs: NOW,
    });

    const byLabel = new Map(slots.map((slot) => [slot.label, slot]));

    expect(byLabel.get("10:00")?.blockedReason).toBe("past");
    expect(byLabel.get("11:30")?.blockedReason).toBe("lead-time");
    expect(byLabel.get("13:00")?.blockedReason).toBe("lead-time");
    expect(byLabel.get("13:30")?.blockedReason).toBe(null);
    expect(byLabel.get("13:30")?.selectable).toBe(true);
    expect(byLabel.get("20:30")?.selectable).toBe(true);
  });

  it("marks the session's existing slot so it cannot be re-picked", () => {
    const currentSlotUtc = toUtcIso("2026-08-08T10:00:00Z"); // 15:30 Kolkata

    const slots = generateDaySlots({
      localDate: "2026-08-08",
      timeZone: zone,
      nowMs: NOW,
      currentSlotUtc,
    });

    const current = slots.find((slot) => slot.utc === currentSlotUtc);
    expect(current?.label).toBe("15:30");
    expect(current?.blockedReason).toBe("current-slot");
    expect(current?.selectable).toBe(false);
  });

  it("every slot it emits is a distinct instant", () => {
    const slots = generateDaySlots({
      localDate: "2026-11-01",
      timeZone: "America/New_York", // a fall-back day
      nowMs: NOW,
    });

    expect(new Set(slots.map((slot) => slot.utc)).size).toBe(slots.length);
  });

  it("is DST-aware: the same reading maps to different instants across a transition", () => {
    // The assertion that proves slots are generated in wall-clock space rather
    // than by adding fixed milliseconds to a converted midnight.
    //
    // New York springs forward on 8 March 2026. "08:00" on the 7th is EST
    // (UTC−5) and on the 8th is EDT (UTC−4) — one hour apart in UTC, despite
    // being the same reading exactly 24 hours later on the wall clock.
    const before = generateDaySlots({
      localDate: "2026-03-07",
      timeZone: "America/New_York",
      nowMs: NOW,
    })[0];

    const after = generateDaySlots({
      localDate: "2026-03-08",
      timeZone: "America/New_York",
      nowMs: NOW,
    })[0];

    expect(before?.label).toBe("08:00");
    expect(after?.label).toBe("08:00");
    expect(before?.utc).toBe("2026-03-07T13:00:00.000Z");
    expect(after?.utc).toBe("2026-03-08T12:00:00.000Z");
  });

  it("returns nothing for a calendar day that never happened", () => {
    // Samoa moved across the international date line at the end of 2011 and
    // skipped 30 December entirely — the whole day is a gap. Nothing in the
    // slot generator special-cases this; it falls out of resolving each
    // reading independently and dropping the ones that do not exist.
    //
    // A generator that added 30 minutes to a converted midnight would happily
    // offer thirteen hours of appointments on a day that did not occur.
    const slots = generateDaySlots({
      localDate: "2011-12-30",
      timeZone: "Pacific/Apia",
      nowMs: Date.parse("2011-12-01T00:00:00Z"),
    });

    expect(slots).toHaveLength(0);
  });
});
