/**
 * Slot generation and the 2-hour lead-time lock-out.
 *
 * ── Why slots are generated in wall-clock space ─────────────────────────────
 *
 * The obvious implementation is to take local midnight, convert it to UTC once,
 * and then add 30 minutes repeatedly. It is also wrong. On the day a zone
 * springs forward, adding a fixed 30 minutes of *elapsed time* walks the wall
 * clock straight through the hour that does not exist, and the picker offers a
 * parent 02:30 on a day where 02:30 never happens. On the day it falls back,
 * the same loop produces 01:30 twice with no way to tell them apart.
 *
 * So the loop below iterates the **wall clock** — 08:00, 08:30, 09:00 — and
 * converts each reading to an instant independently. Readings inside a gap come
 * back as `dst-gap` and are dropped; the picker then simply has fewer slots
 * that day, which is the truth. Everything downstream is an instant.
 */

import {
  BOOKING_DAY_END_HOUR,
  BOOKING_DAY_START_HOUR,
  CLOCK_SKEW_GRACE_MS,
  RESCHEDULE_LEAD_TIME_MS,
  SLOT_GRANULARITY_MINUTES,
} from "./policy";
import { formatInZone, toUtcIso, wallClockToUtc } from "./time";
import type { LocalWallClock, TimeZoneId, UtcIsoString } from "./types";

/** Why a slot cannot be picked. `null` means it can. */
export type SlotBlockedReason = "past" | "lead-time" | "current-slot";

export interface TimeSlot {
  /** The instant that will be stored. This is the value that gets submitted. */
  readonly utc: UtcIsoString;
  /** The same instant as the parent's clock reads it. Display only. */
  readonly wallClock: LocalWallClock;
  /** e.g. `14:30`. Display only. */
  readonly label: string;
  readonly blockedReason: SlotBlockedReason | null;
  readonly selectable: boolean;
}

/**
 * The earliest instant a parent may reschedule *to*.
 *
 * Derived from the server-authoritative `nowMs` plus the policy window. The
 * client calls this with its own clock to grey out slots; the server calls it
 * with its own to enforce. Same function, same constant, so the UI and the
 * validator cannot disagree about where the boundary is.
 */
export function earliestBookableInstantMs(nowMs: number): number {
  return nowMs + RESCHEDULE_LEAD_TIME_MS;
}

export function earliestBookableUtc(nowMs: number): UtcIsoString {
  return toUtcIso(earliestBookableInstantMs(nowMs));
}

/**
 * Does this instant satisfy the 2-hour rule?
 *
 * `CLOCK_SKEW_GRACE_MS` is subtracted from the boundary rather than added to
 * `nowMs`, so the grace only ever *admits* a borderline slot; it can never
 * reject one. See the note on the constant for why a grace window is needed at
 * all.
 */
export function satisfiesLeadTime(slotUtc: UtcIsoString, nowMs: number): boolean {
  return (
    new Date(slotUtc).getTime() >=
    earliestBookableInstantMs(nowMs) - CLOCK_SKEW_GRACE_MS
  );
}

export function isInPast(slotUtc: UtcIsoString, nowMs: number): boolean {
  return new Date(slotUtc).getTime() < nowMs - CLOCK_SKEW_GRACE_MS;
}

export interface GenerateSlotsArgs {
  /** `YYYY-MM-DD` in the parent's zone — the day they are looking at. */
  readonly localDate: string;
  readonly timeZone: TimeZoneId;
  /** Caller's clock. Injected rather than read, so this is pure and testable. */
  readonly nowMs: number;
  /** The session's current slot, so it can be marked and not re-picked. */
  readonly currentSlotUtc?: UtcIsoString;
}

/**
 * Every bookable reading on one local day, each already resolved to an instant
 * and already judged against the lead-time policy.
 */
export function generateDaySlots({
  localDate,
  timeZone,
  nowMs,
  currentSlotUtc,
}: GenerateSlotsArgs): readonly TimeSlot[] {
  const earliest = earliestBookableInstantMs(nowMs) - CLOCK_SKEW_GRACE_MS;
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();

  const totalMinutes = (BOOKING_DAY_END_HOUR - BOOKING_DAY_START_HOUR) * 60;

  for (
    let offset = 0;
    offset < totalMinutes;
    offset += SLOT_GRANULARITY_MINUTES
  ) {
    const hour = BOOKING_DAY_START_HOUR + Math.floor(offset / 60);
    const minute = offset % 60;
    const reading = `${localDate}T${String(hour).padStart(2, "0")}:${String(
      minute,
    ).padStart(2, "0")}`;

    const conversion = wallClockToUtc(reading, timeZone);

    // A reading inside a spring-forward gap is not a real time. Offering it
    // would mean silently booking the parent into a different hour than the one
    // they tapped, so it is dropped and the day just has fewer slots.
    if (conversion.kind === "dst-gap") continue;

    // On a fall-back day the same reading exists twice; `wallClockToUtc` gives
    // us the first occurrence. Deduping on the instant keeps the list honest.
    if (seen.has(conversion.utc)) continue;
    seen.add(conversion.utc);

    const slotMs = new Date(conversion.utc).getTime();

    let blockedReason: SlotBlockedReason | null = null;
    if (currentSlotUtc && conversion.utc === currentSlotUtc) {
      blockedReason = "current-slot";
    } else if (slotMs < nowMs) {
      blockedReason = "past";
    } else if (slotMs < earliest) {
      // In the future, but inside the 2-hour window. This is the lock-out.
      blockedReason = "lead-time";
    }

    slots.push({
      utc: conversion.utc,
      wallClock: reading as LocalWallClock,
      label: formatInZone(conversion.utc, timeZone, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      blockedReason,
      selectable: blockedReason === null,
    });
  }

  return slots;
}

/** `YYYY-MM-DD` labels for the days a parent may browse. */
export function bookableDays(
  fromLocalDate: string,
  count: number,
  addDays: (date: string, days: number) => string,
): readonly string[] {
  return Array.from({ length: count }, (_, index) =>
    addDays(fromLocalDate, index),
  );
}
