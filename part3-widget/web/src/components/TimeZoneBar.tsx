"use client";

/**
 * The timezone control, and the mismatch notice.
 *
 * ── Why the profile zone, and not the browser's ─────────────────────────────
 *
 * The tempting implementation is to read
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` and render everything in
 * it. That breaks server rendering: the server has no access to the device's
 * zone, so it renders in the container's zone (UTC), the browser re-renders in
 * the parent's, the two disagree, and React discards the server HTML. In
 * production that failure is silent — you get a flash of the wrong times and no
 * error anywhere.
 *
 * So the zone stored on the parent's **account** is authoritative for the first
 * paint. The server knows it, the client knows it, and the markup matches
 * exactly. The browser's zone is then detected after mount and only used to ask
 * a question — "you look like you're somewhere else, want to switch?" — which
 * is also the honest product behaviour: a parent travelling for a week has not
 * moved their child's lessons to a new timezone, and silently re-rendering the
 * whole schedule around the airport they are sitting in is not helpful.
 *
 * The picker is here so the local/UTC separation is demonstrable: change the
 * zone and every displayed time moves, while the underlying instants — printed
 * in the reschedule form — do not.
 */

import { zonesRenderIdentically, type TimeZoneId } from "@debe/shared";
import { useMemo } from "react";

const ZONE_OPTIONS: readonly TimeZoneId[] = [
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "Australia/Sydney",
  "UTC",
];

interface TimeZoneBarProps {
  readonly profileTimeZone: TimeZoneId;
  readonly viewTimeZone: TimeZoneId;
  readonly detectedTimeZone: string | null;
  readonly onChange: (timeZone: TimeZoneId) => void;
}

export function TimeZoneBar({
  profileTimeZone,
  viewTimeZone,
  detectedTimeZone,
  onChange,
}: TimeZoneBarProps) {
  // `detectedTimeZone` is null until mount — nothing derived from the device
  // may appear in the server HTML, or the first paint won't match.
  //
  // The comparison is `zonesRenderIdentically`, not `!==`. Chrome reports
  // `Asia/Calcutta` for a device set to `Asia/Kolkata` — the same zone under a
  // legacy IANA alias — and a string comparison offered an Indian parent the
  // chance to switch from their timezone to their timezone.
  const mismatch =
    detectedTimeZone !== null &&
    !zonesRenderIdentically(detectedTimeZone, viewTimeZone);

  // Same reasoning for the dropdown itself: appending the detected zone by
  // string identity would list "Asia/Kolkata" and "Asia/Calcutta" as two
  // choices that do exactly the same thing.
  const options = useMemo(() => {
    const list = [...ZONE_OPTIONS];
    for (const candidate of [viewTimeZone, detectedTimeZone]) {
      if (
        typeof candidate === "string" &&
        !list.some((zone) => zonesRenderIdentically(zone, candidate))
      ) {
        list.push(candidate);
      }
    }
    return list;
  }, [viewTimeZone, detectedTimeZone]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label
          htmlFor="tz"
          className="text-[11px] font-medium uppercase tracking-wider text-ink-3"
        >
          Showing times in
        </label>
        <select
          id="tz"
          value={viewTimeZone}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] font-medium text-ink"
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
              {zone === profileTimeZone ? " (your account)" : ""}
            </option>
          ))}
        </select>
      </div>

      {mismatch && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[12px] text-ink-2">
          <span>
            Your device says{" "}
            <span className="font-medium text-ink">
              {detectedTimeZone.replace("_", " ")}
            </span>
            .
          </span>
          <button
            type="button"
            onClick={() => onChange(detectedTimeZone)}
            className="font-semibold text-accent underline underline-offset-2"
          >
            Show times in that zone
          </button>
        </p>
      )}
    </div>
  );
}
