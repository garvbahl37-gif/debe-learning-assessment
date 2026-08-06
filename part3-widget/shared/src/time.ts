/**
 * Time arithmetic for the reschedule widget.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 *
 *   Store instants. Render wall clocks. Convert at exactly one boundary.
 *
 * `startsAtUtc` on a session is an *instant* — a fixed point on the world's
 * timeline. "3pm" is not; it is a reading on somebody's clock, and which
 * instant it names depends on where that clock is and what the government did
 * to daylight saving that year. The portal stores only instants, and turns them
 * into wall clocks at the last possible moment, per viewer.
 *
 * The dangerous direction is the reverse one. `<input type="datetime-local">`
 * hands you `"2026-08-08T15:00"` — a wall clock with no zone. Every scheduling
 * bug I have had to debug in production has been someone treating that string
 * as an instant: `new Date("2026-08-08T15:00")` parses it in the *runtime's*
 * local zone, which on a server is UTC and on a laptop is whatever the laptop
 * says. The booking then lands hours off, and only for users who aren't in the
 * same zone as the server — so it survives every test you run at your desk.
 *
 * `wallClockToUtc()` below is the single sanctioned crossing point, and the
 * branded `LocalWallClock` / `UtcIsoString` types in `types.ts` make the
 * compiler refuse anything that tries to go around it.
 *
 * No date library. This is ~150 lines of `Intl.DateTimeFormat` and it means the
 * timezone database is the platform's, always current, with nothing to keep
 * patched.
 */

import type {
  LocalWallClock,
  TimeZoneId,
  UtcIsoString,
} from "./types";

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Constructors — the only sanctioned way to mint a branded string
// ─────────────────────────────────────────────────────────────────────────────

/** `2026-08-08T09:30:00.000Z` — always with milliseconds, always `Z`. */
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `2026-08-08T15:00` — what `<input type="datetime-local">` produces. */
const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `2026-08-08` — a calendar date in some zone. */
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class TimeParseError extends Error {}

/**
 * Normalise anything instant-shaped into the one canonical UTC form.
 *
 * Canonicalising matters beyond tidiness: slots get compared for equality, and
 * `…T09:30:00Z`, `…T09:30:00.000Z` and `…T15:00:00+05:30` are the same instant
 * written three ways. Comparing the raw strings would say they differ. (This is
 * the same trap as the supporting bug in Part 2.)
 */
export function toUtcIso(value: Date | number | string): UtcIsoString {
  const date =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? new Date(parseInstantOrThrow(value))
        : value;

  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new TimeParseError(`Not a valid instant: ${String(value)}`);
  }
  return date.toISOString() as UtcIsoString;
}

function parseInstantOrThrow(value: string): number {
  // Reject strings with no offset designator. Per the ECMAScript spec a
  // date-time with no zone is parsed as *local* time, so the same string means
  // different instants on a laptop in Mumbai and a container in us-central1.
  // Silently guessing is how you ship a 5.5-hour bug.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TimeParseError(
      `"${value}" has no UTC offset. An instant must carry "Z" or "±HH:MM" — ` +
        `use wallClockToUtc() if this is a local wall-clock reading.`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TimeParseError(`"${value}" is not a valid ISO-8601 datetime.`);
  }
  return ms;
}

export function isUtcIsoString(value: unknown): value is UtcIsoString {
  return typeof value === "string" && UTC_ISO_PATTERN.test(value);
}

/** Validates and brands a `datetime-local` value. */
export function asWallClock(value: string): LocalWallClock {
  if (!WALL_CLOCK_PATTERN.test(value)) {
    throw new TimeParseError(
      `"${value}" is not a wall-clock reading (expected YYYY-MM-DDTHH:mm).`,
    );
  }
  return value as LocalWallClock;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone offsets, via Intl
// ─────────────────────────────────────────────────────────────────────────────

// `Intl.DateTimeFormat` construction is not cheap and these get called in a
// loop when generating a day of slots.
const partsFormatterCache = new Map<TimeZoneId, Intl.DateTimeFormat>();

function partsFormatter(timeZone: TimeZoneId): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `hourCycle: "h23"` rather than `hour12: false`. They are not synonyms:
    // `hour12: false` yields hour "24" for midnight under some ICU versions,
    // which then feeds a 24 into Date.UTC and rolls the date forward by a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What a clock in `timeZone` reads at the given instant. */
function zonedParts(instant: Date, timeZone: TimeZoneId): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new TimeParseError(`Intl gave no "${type}" part for ${timeZone}.`);
    }
    return Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The zone's UTC offset in milliseconds, **at a specific instant**.
 *
 * It has to be "at an instant" rather than a property of the zone — that is the
 * whole point of DST. `Asia/Kolkata` is always +05:30; `Europe/London` is +00:00
 * in January and +01:00 in July.
 *
 * The trick: format the instant into the target zone, then reinterpret those
 * digits as if they were UTC. The gap between that and the real instant is the
 * offset.
 */
export function zoneOffsetMsAt(instant: Date, timeZone: TimeZoneId): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    instant.getUTCMilliseconds(),
  );
  return asIfUtc - instant.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// UTC → wall clock
// ─────────────────────────────────────────────────────────────────────────────

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

/** The `YYYY-MM-DDTHH:mm` a clock in `timeZone` shows at this instant. */
export function utcToWallClock(
  utc: UtcIsoString,
  timeZone: TimeZoneId,
): LocalWallClock {
  const parts = zonedParts(new Date(utc), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}` as LocalWallClock;
}

/** The `YYYY-MM-DD` calendar date in `timeZone` at this instant. */
export function localDateInZone(
  instantMs: number,
  timeZone: TimeZoneId,
): string {
  const parts = zonedParts(new Date(instantMs), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` string. No zone involved. */
export function addDaysToLocalDate(localDate: string, days: number): string {
  const match = LOCAL_DATE_PATTERN.exec(localDate);
  if (!match) {
    throw new TimeParseError(`"${localDate}" is not a YYYY-MM-DD date.`);
  }
  const [, year, month, day] = match;
  const shifted = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)) + days * DAY_MS,
  );
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const displayFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** Formats an instant for a human, in a specific zone. */
export function formatInZone(
  utc: UtcIsoString,
  timeZone: TimeZoneId,
  options: Intl.DateTimeFormatOptions,
  locale = "en-GB",
): string {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let formatter = displayFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    displayFormatterCache.set(key, formatter);
  }
  return formatter.format(new Date(utc));
}

/** e.g. `GMT+5:30` — shown next to times so the zone is never implicit. */
export function zoneAbbreviation(
  utc: UtcIsoString,
  timeZone: TimeZoneId,
): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utc));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall clock → UTC  (the direction that goes wrong)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome of interpreting a wall clock in a zone.
 *
 * Most of the year this is boring and `exact`. Twice a year, in zones that
 * observe DST, a wall-clock reading is genuinely not a single instant:
 *
 *  - **`dst-gap`** — the reading never happens. When New York springs forward,
 *    clocks go 01:59 → 03:00, so "02:30" does not exist that day. We resolve
 *    forward by the size of the gap (03:30), which is what iCalendar and
 *    Temporal's `compatible` mode both do, and report the shift so the UI can
 *    say so out loud rather than silently booking a different time.
 *
 *  - **`dst-ambiguous`** — the reading happens twice. When New York falls back,
 *    01:30 occurs once in EDT and again an hour later in EST. We take the
 *    first (earlier) occurrence and hand back the other so it can be offered.
 *
 * Returning this as a discriminated union rather than just a `Date` is the
 * point: a function that returns `Date` has to pick silently, and silently
 * picking is how a family shows up an hour late twice a year.
 */
export type WallClockConversion =
  | { readonly kind: "exact"; readonly utc: UtcIsoString }
  | {
      readonly kind: "dst-gap";
      readonly utc: UtcIsoString;
      /** What the requested reading actually resolved to. */
      readonly resolvedWallClock: LocalWallClock;
    }
  | {
      readonly kind: "dst-ambiguous";
      readonly utc: UtcIsoString;
      /** The second, later occurrence of the same reading. */
      readonly alternativeUtc: UtcIsoString;
    };

/**
 * Interpret a wall-clock reading in a zone and return the instant.
 *
 * Algorithm: a wall clock plus a zone gives a candidate instant only once you
 * know the offset — but the offset depends on the instant, which is what we are
 * solving for. So we sample the offset a day either side (comfortably outside
 * any transition), build a candidate from each, and keep the ones that round-
 * trip back to the reading we were given.
 *
 *   two survivors → the reading happens twice   (fall back)
 *   one survivor  → the normal case
 *   none          → the reading never happens    (spring forward)
 */
export function wallClockToUtc(
  wallClock: LocalWallClock | string,
  timeZone: TimeZoneId,
): WallClockConversion {
  const match = WALL_CLOCK_PATTERN.exec(wallClock);
  if (!match) {
    throw new TimeParseError(
      `"${wallClock}" is not a wall-clock reading (expected YYYY-MM-DDTHH:mm).`,
    );
  }
  if (!isValidTimeZone(timeZone)) {
    throw new TimeParseError(`"${timeZone}" is not a known IANA timezone.`);
  }

  const [, year, month, day, hour, minute] = match;
  const naiveMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );

  const offsetBefore = zoneOffsetMsAt(new Date(naiveMs - DAY_MS), timeZone);
  const offsetAfter = zoneOffsetMsAt(new Date(naiveMs + DAY_MS), timeZone);

  const candidates =
    offsetBefore === offsetAfter
      ? [naiveMs - offsetBefore]
      : [naiveMs - offsetBefore, naiveMs - offsetAfter];

  const target = wallClock as string;
  const survivors = candidates.filter(
    (candidateMs) => utcToWallClock(toUtcIso(candidateMs), timeZone) === target,
  );

  if (survivors.length >= 2) {
    const earliest = Math.min(...survivors);
    const latest = Math.max(...survivors);
    return {
      kind: "dst-ambiguous",
      utc: toUtcIso(earliest),
      alternativeUtc: toUtcIso(latest),
    };
  }

  if (survivors.length === 1) {
    return { kind: "exact", utc: toUtcIso(survivors[0]!) };
  }

  // Spring-forward gap. Resolve forward — the later candidate is the one past
  // the jump, so "02:30" on a gap day becomes 03:30 rather than 01:30.
  const resolvedMs = Math.max(...candidates);
  const utc = toUtcIso(resolvedMs);
  return {
    kind: "dst-gap",
    utc,
    resolvedWallClock: utcToWallClock(utc, timeZone),
  };
}
