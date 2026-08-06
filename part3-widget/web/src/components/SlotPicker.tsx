"use client";

/**
 * The date/time picker.
 *
 * ── Why this is a slot grid and not `<input type="datetime-local">` ─────────
 *
 * A native datetime input cannot express "these particular times are
 * unavailable". Its `min` attribute gives you a floor and nothing else, so a
 * parent can still type 03:15 on a day the tutor doesn't work, and you are back
 * to rejecting it on submit — which is exactly the experience the brief's
 * lead-time requirement is trying to avoid.
 *
 * The `min` attribute has a second, quieter problem: it is a **wall-clock**
 * string with no zone. The browser compares the typed value against it in the
 * device's local terms, so the moment the parent's device zone and the zone the
 * portal is displaying diverge, the floor lands in the wrong place. You cannot
 * express "two hours from now, in UTC" to that attribute at all.
 *
 * A discrete grid sidesteps both. Every button below is a real instant computed
 * by `generateDaySlots()`, already judged against the policy, and the disabled
 * ones say why they are disabled instead of failing later.
 */

import {
  LEAD_TIME_LABEL,
  addDaysToLocalDate,
  formatInZone,
  generateDaySlots,
  localDateInZone,
  toUtcIso,
  type SlotBlockedReason,
  type TimeSlot,
  type TimeZoneId,
  type UtcIsoString,
} from "@debe/shared";
import { useMemo } from "react";

const DAYS_VISIBLE = 10;

const BLOCKED_LABEL: Readonly<Record<SlotBlockedReason, string>> = {
  past: "Already passed",
  "lead-time": `Less than ${LEAD_TIME_LABEL}’ notice`,
  "current-slot": "Current booking",
};

interface SlotPickerProps {
  readonly timeZone: TimeZoneId;
  readonly nowMs: number;
  readonly currentSlotUtc: UtcIsoString;
  readonly selectedUtc: UtcIsoString | null;
  readonly activeDate: string;
  readonly onDateChange: (localDate: string) => void;
  readonly onSelect: (slot: TimeSlot) => void;
  readonly disabled: boolean;
}

export function SlotPicker({
  timeZone,
  nowMs,
  currentSlotUtc,
  selectedUtc,
  activeDate,
  onDateChange,
  onSelect,
  disabled,
}: SlotPickerProps) {
  const today = localDateInZone(nowMs, timeZone);

  const days = useMemo(
    () =>
      Array.from({ length: DAYS_VISIBLE }, (_, index) =>
        addDaysToLocalDate(today, index),
      ),
    [today],
  );

  // Recomputed whenever `nowMs` ticks, so a slot that ages into the 2-hour
  // window greys itself out while the form is open.
  const slots = useMemo(
    () =>
      generateDaySlots({
        localDate: activeDate,
        timeZone,
        nowMs,
        currentSlotUtc,
      }),
    [activeDate, timeZone, nowMs, currentSlotUtc],
  );

  const availableCount = slots.filter((slot) => slot.selectable).length;
  const lockedOutCount = slots.filter(
    (slot) => slot.blockedReason === "lead-time",
  ).length;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h4 className="text-[13px] font-semibold tracking-tight text-ink">
            Pick a day
          </h4>
          <span className="text-[11px] text-ink-3">
            Times shown in {timeZone.replace("_", " ")}
          </span>
        </div>

        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="Choose a day"
        >
          {days.map((day) => {
            const isActive = day === activeDate;
            const offset = daysBetween(today, day);
            return (
              <button
                key={day}
                type="button"
                disabled={disabled}
                onClick={() => onDateChange(day)}
                aria-pressed={isActive}
                className={[
                  "shrink-0 rounded-md border px-3 py-2 text-left transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  isActive
                    ? "border-accent bg-accent-soft"
                    : "border-line bg-surface hover:border-line-strong",
                ].join(" ")}
              >
                <span
                  className={[
                    "block text-[10px] font-medium uppercase tracking-wider",
                    isActive ? "text-accent" : "text-ink-3",
                  ].join(" ")}
                >
                  {offset === 0
                    ? "Today"
                    : offset === 1
                      ? "Tomorrow"
                      : weekdayLabel(day)}
                </span>
                <span className="tnum block text-sm font-semibold text-ink">
                  {dayNumberLabel(day)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h4 className="text-[13px] font-semibold tracking-tight text-ink">
            Pick a time
          </h4>
          <span className="tnum text-[11px] text-ink-3">
            {availableCount} available
          </span>
        </div>

        {slots.length === 0 ? (
          <p className="rounded-md border border-line bg-sunken px-3 py-6 text-center text-[13px] text-ink-2">
            No slots on this day.
          </p>
        ) : (
          <div
            className="grid grid-cols-3 gap-1.5 sm:grid-cols-4"
            role="group"
            aria-label="Choose a time"
          >
            {slots.map((slot) => (
              <SlotButton
                key={slot.utc}
                slot={slot}
                selected={slot.utc === selectedUtc}
                disabled={disabled}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}

        {lockedOutCount > 0 && (
          // The lock-out is stated, not just rendered as grey pixels. A parent
          // looking at a row of dead buttons with no explanation assumes the
          // app is broken; told the reason, they scroll to tomorrow.
          <p className="mt-2.5 flex items-start gap-1.5 rounded-md border border-warn-line bg-warn-soft px-2.5 py-2 text-[12px] leading-relaxed text-warn">
            <LockIcon />
            <span>
              <span className="tnum font-semibold">{lockedOutCount}</span>{" "}
              {lockedOutCount === 1 ? "time is" : "times are"} inside the{" "}
              {LEAD_TIME_LABEL}’ notice your tutor needs to prepare, so{" "}
              {lockedOutCount === 1 ? "it" : "they"} can’t be booked.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function SlotButton({
  slot,
  selected,
  disabled,
  onSelect,
}: {
  slot: TimeSlot;
  selected: boolean;
  disabled: boolean;
  onSelect: (slot: TimeSlot) => void;
}) {
  const blocked = slot.blockedReason;
  const reason = blocked ? BLOCKED_LABEL[blocked] : null;

  return (
    <button
      type="button"
      disabled={disabled || !slot.selectable}
      onClick={() => onSelect(slot)}
      aria-pressed={selected}
      // The reason reaches assistive tech too, not just the tooltip. A disabled
      // button that announces only its time is indistinguishable from a bug.
      aria-label={reason ? `${slot.label} — ${reason}` : slot.label}
      title={reason ?? undefined}
      className={[
        "tnum rounded-md border px-2 py-2 text-[13px] font-medium transition-colors",
        selected
          ? "border-accent bg-accent text-white shadow-sm"
          : blocked === "lead-time"
            ? "cursor-not-allowed border-warn-line bg-warn-soft text-warn/70 line-through decoration-1"
            : blocked
              ? "cursor-not-allowed border-line bg-sunken text-ink-3 line-through decoration-1"
              : "border-line bg-surface text-ink hover:border-accent hover:bg-accent-soft",
      ].join(" ")}
    >
      {slot.label}
    </button>
  );
}

function LockIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-0.5 shrink-0"
    >
      <rect
        x="3.25"
        y="7"
        width="9.5"
        height="6.5"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

const DAY_MS = 86_400_000;

/** Both arguments are `YYYY-MM-DD` in the same zone, so plain UTC maths is safe. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// Labelling a bare calendar date. Anchored at noon UTC and formatted in UTC —
// the label must read "8 Aug" for the string "2026-08-08" regardless of who is
// looking, and anchoring at midnight would let any negative offset render the
// day before. Going through `toUtcIso` rather than casting keeps the brand
// honest: nothing in this file mints a `UtcIsoString` by assertion.
function dateLabel(localDate: string, options: Intl.DateTimeFormatOptions): string {
  return formatInZone(toUtcIso(`${localDate}T12:00:00Z`), "UTC", options);
}

function weekdayLabel(localDate: string): string {
  return dateLabel(localDate, { weekday: "short" });
}

function dayNumberLabel(localDate: string): string {
  return dateLabel(localDate, { day: "numeric", month: "short" });
}
