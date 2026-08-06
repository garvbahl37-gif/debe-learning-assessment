/**
 * The local ⇄ UTC boundary.
 *
 * These are the tests that would have caught every scheduling bug I have had to
 * debug in production, so they are the ones written first.
 */

import { describe, expect, it } from "vitest";

import {
  TimeParseError,
  formatInZone,
  toUtcIso,
  utcToWallClock,
  wallClockToUtc,
  zoneOffsetMsAt,
  zonesRenderIdentically,
} from "@debe/shared";

const HOUR = 3_600_000;

describe("toUtcIso", () => {
  it("collapses the same instant written three ways into one string", () => {
    // The bug this defends against: comparing slots as raw strings. All three
    // of these are the same moment; a `==` between any two of them is false.
    const withZ = toUtcIso("2026-08-08T09:30:00Z");
    const withMillis = toUtcIso("2026-08-08T09:30:00.000Z");
    const withOffset = toUtcIso("2026-08-08T15:00:00+05:30");

    expect(withZ).toBe("2026-08-08T09:30:00.000Z");
    expect(withMillis).toBe(withZ);
    expect(withOffset).toBe(withZ);
  });

  it("refuses a datetime with no offset instead of guessing", () => {
    // Per the ECMAScript spec this would be parsed as *local* time, so the same
    // string means different instants on a laptop and in a container. Guessing
    // silently is how you ship a five-and-a-half-hour bug.
    expect(() => toUtcIso("2026-08-08T15:00:00")).toThrow(TimeParseError);
    expect(() => toUtcIso("2026-08-08T15:00")).toThrow(/no UTC offset/);
  });

  it("rejects nonsense rather than producing an Invalid Date", () => {
    expect(() => toUtcIso("not a date")).toThrow(TimeParseError);
  });
});

describe("zoneOffsetMsAt", () => {
  it("returns a fixed offset for a zone that does not observe DST", () => {
    const january = new Date("2026-01-15T12:00:00Z");
    const july = new Date("2026-07-15T12:00:00Z");

    expect(zoneOffsetMsAt(january, "Asia/Kolkata")).toBe(5.5 * HOUR);
    expect(zoneOffsetMsAt(july, "Asia/Kolkata")).toBe(5.5 * HOUR);
  });

  it("returns a different offset either side of a DST boundary", () => {
    // This is why the offset has to be a function of the instant, not a
    // property of the zone.
    expect(zoneOffsetMsAt(new Date("2026-01-15T12:00:00Z"), "Europe/London")).toBe(0);
    expect(zoneOffsetMsAt(new Date("2026-07-15T12:00:00Z"), "Europe/London")).toBe(HOUR);
  });
});

describe("wallClockToUtc — the ordinary case", () => {
  it("interprets a reading in a half-hour-offset zone", () => {
    const result = wallClockToUtc("2026-08-08T15:00", "Asia/Kolkata");

    expect(result.kind).toBe("exact");
    expect(result.utc).toBe("2026-08-08T09:30:00.000Z");
  });

  it("gives the same reading two different instants in summer and winter", () => {
    // The single most important assertion in this file. "3pm in London" is not
    // one instant — it is 15:00Z in January and 14:00Z in July. Any code that
    // stores "15:00" and reconstructs it later gets one of these wrong.
    const winter = wallClockToUtc("2026-01-08T15:00", "Europe/London");
    const summer = wallClockToUtc("2026-07-08T15:00", "Europe/London");

    expect(winter.utc).toBe("2026-01-08T15:00:00.000Z");
    expect(summer.utc).toBe("2026-07-08T14:00:00.000Z");
  });

  it("round-trips through the wall clock it came from", () => {
    for (const zone of [
      "Asia/Kolkata",
      "Europe/London",
      "America/New_York",
      "Australia/Sydney",
      "UTC",
    ]) {
      for (const reading of [
        "2026-01-15T08:00",
        "2026-06-21T13:30",
        "2026-11-03T20:30",
      ]) {
        const forward = wallClockToUtc(reading, zone);
        expect(utcToWallClock(forward.utc, zone)).toBe(reading);
      }
    }
  });
});

describe("wallClockToUtc — DST edges", () => {
  // New York springs forward on Sunday 8 March 2026: 01:59 → 03:00.
  it("reports a reading inside the spring-forward gap, and resolves it forward", () => {
    const result = wallClockToUtc("2026-03-08T02:30", "America/New_York");

    expect(result.kind).toBe("dst-gap");
    if (result.kind !== "dst-gap") throw new Error("narrowing");

    // 02:30 does not exist that day. Resolving forward lands on 03:30 EDT,
    // matching iCalendar and Temporal's `compatible` disambiguation — and, more
    // to the point, never silently booking someone an hour *earlier* than they
    // asked for.
    expect(result.resolvedWallClock).toBe("2026-03-08T03:30");
    expect(result.utc).toBe("2026-03-08T07:30:00.000Z");
  });

  it("leaves readings either side of the gap alone", () => {
    expect(wallClockToUtc("2026-03-08T01:30", "America/New_York").kind).toBe("exact");
    expect(wallClockToUtc("2026-03-08T03:30", "America/New_York").kind).toBe("exact");
  });

  // New York falls back on Sunday 1 November 2026: 01:59 EDT → 01:00 EST.
  it("reports a reading that happens twice, and offers both instants", () => {
    const result = wallClockToUtc("2026-11-01T01:30", "America/New_York");

    expect(result.kind).toBe("dst-ambiguous");
    if (result.kind !== "dst-ambiguous") throw new Error("narrowing");

    // First occurrence is EDT (UTC-4), second is EST (UTC-5), an hour apart.
    expect(result.utc).toBe("2026-11-01T05:30:00.000Z");
    expect(result.alternativeUtc).toBe("2026-11-01T06:30:00.000Z");

    // Both genuinely read 01:30 to someone in New York. That is the whole
    // problem with storing a wall clock.
    expect(utcToWallClock(result.utc, "America/New_York")).toBe("2026-11-01T01:30");
    expect(utcToWallClock(result.alternativeUtc, "America/New_York")).toBe(
      "2026-11-01T01:30",
    );
  });

  it("handles London's transitions, which are at a different hour from New York's", () => {
    // Worth pinning for two reasons.
    //
    // First, the hour differs: the US switches at 02:00 *local*, the UK at
    // 01:00 GMT. So London's gap is 01:00–02:00 and New York's is 02:00–03:00.
    // Hard-coding "2am" as the transition hour is a real and common mistake.
    //
    // Second, the dates differ: the EU and US switch on different weekends, so
    // for a fortnight each spring the usual London↔New York gap is four hours
    // instead of five. A tutoring portal spanning both gets support tickets in
    // exactly that fortnight.
    expect(wallClockToUtc("2026-03-29T01:30", "Europe/London").kind).toBe("dst-gap");
    expect(wallClockToUtc("2026-03-29T02:30", "Europe/London").kind).toBe("exact");

    expect(wallClockToUtc("2026-10-25T01:30", "Europe/London").kind).toBe(
      "dst-ambiguous",
    );
  });

  it("rejects an unknown timezone rather than falling back to UTC", () => {
    expect(() => wallClockToUtc("2026-08-08T15:00", "Mars/Olympus_Mons")).toThrow(
      TimeParseError,
    );
  });

  it("rejects a malformed reading", () => {
    expect(() => wallClockToUtc("8 August, 3pm", "Asia/Kolkata")).toThrow(
      TimeParseError,
    );
  });
});

describe("zonesRenderIdentically", () => {
  it("treats a legacy IANA alias as the same zone", () => {
    // The bug this exists for: Chrome reports `Asia/Calcutta` from
    // resolvedOptions() for a device set to `Asia/Kolkata`. A string comparison
    // then told a parent in India their device was somewhere else and offered
    // to switch them from their timezone to their timezone.
    expect(zonesRenderIdentically("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(zonesRenderIdentically("Europe/Kyiv", "Europe/Kiev")).toBe(true);
    expect(
      zonesRenderIdentically(
        "America/Argentina/Buenos_Aires",
        "America/Buenos_Aires",
      ),
    ).toBe(true);
  });

  it("still separates zones that genuinely differ", () => {
    expect(zonesRenderIdentically("Asia/Kolkata", "Europe/London")).toBe(false);
    expect(zonesRenderIdentically("America/New_York", "America/Chicago")).toBe(
      false,
    );
  });

  it("separates zones that share an offset for part of the year but not all of it", () => {
    // Both are UTC+0 in winter; only London goes to +1 in summer. Sampling a
    // single instant would call these identical, which is why the check spans
    // four quarters.
    expect(zonesRenderIdentically("Europe/London", "UTC")).toBe(false);
    // Arizona doesn't observe DST; Denver does.
    expect(
      zonesRenderIdentically("America/Phoenix", "America/Denver"),
    ).toBe(false);
  });

  it("is false rather than throwing for an unknown zone", () => {
    expect(zonesRenderIdentically("Asia/Kolkata", "Mars/Olympus_Mons")).toBe(
      false,
    );
  });
});

describe("formatInZone", () => {
  it("renders one instant differently for two parents in different zones", () => {
    // The same session. Nothing about it changes — only who is looking.
    const instant = toUtcIso("2026-08-08T09:30:00Z");

    const options: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };

    expect(formatInZone(instant, "Asia/Kolkata", options)).toBe("15:00");
    expect(formatInZone(instant, "Europe/London", options)).toBe("10:30");
    expect(formatInZone(instant, "UTC", options)).toBe("09:30");
  });
});
