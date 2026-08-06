"use client";

import {
  NOTE_MAX_LENGTH,
  RESCHEDULE_REASONS,
  RESCHEDULE_REASON_LABELS,
  formatInZone,
  localDateInZone,
  zoneAbbreviation,
  type RescheduleReason,
  type TimeSlot,
  type TimeZoneId,
  type TutoringSession,
  type UtcIsoString,
} from "@debe/shared";
import { useId, useState } from "react";

import { SlotPicker } from "./SlotPicker";

interface RescheduleFormProps {
  readonly session: TutoringSession;
  readonly timeZone: TimeZoneId;
  readonly nowMs: number;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    newSlotUtc: UtcIsoString;
    reason: RescheduleReason;
    note: string;
  }) => void;
}

export function RescheduleForm({
  session,
  timeZone,
  nowMs,
  pending,
  error,
  onCancel,
  onSubmit,
}: RescheduleFormProps) {
  const [activeDate, setActiveDate] = useState(() =>
    localDateInZone(new Date(session.startsAtUtc).getTime(), timeZone),
  );
  const [selected, setSelected] = useState<TimeSlot | null>(null);
  const [reason, setReason] = useState<RescheduleReason>("conflict");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const reasonId = useId();
  const noteId = useId();
  const errorId = useId();

  const noteRequired = reason === "other";
  const noteMissing = noteRequired && note.trim() === "";
  const canSubmit = selected !== null && !noteMissing && !pending;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!selected || noteMissing || pending) return;
    onSubmit({ newSlotUtc: selected.utc, reason, note: note.trim() });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-line bg-sunken px-4 py-4 sm:px-5"
      aria-label={`Reschedule ${session.subject}`}
    >
      <SlotPicker
        timeZone={timeZone}
        nowMs={nowMs}
        currentSlotUtc={session.startsAtUtc}
        selectedUtc={selected?.utc ?? null}
        activeDate={activeDate}
        onDateChange={(date) => {
          setActiveDate(date);
          setSelected(null);
        }}
        onSelect={setSelected}
        disabled={pending}
      />

      {selected && (
        <SelectionSummary
          slot={selected}
          timeZone={timeZone}
          currentSlotUtc={session.startsAtUtc}
        />
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={reasonId}
            className="mb-1.5 block text-[13px] font-semibold tracking-tight text-ink"
          >
            Reason
          </label>
          <select
            id={reasonId}
            value={reason}
            disabled={pending}
            onChange={(event) =>
              setReason(event.target.value as RescheduleReason)
            }
            className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-[13px] text-ink disabled:opacity-50"
          >
            {RESCHEDULE_REASONS.map((value) => (
              <option key={value} value={value}>
                {RESCHEDULE_REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={noteId}
            className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-semibold tracking-tight text-ink"
          >
            <span>
              Note{" "}
              <span className="font-normal text-ink-3">
                {noteRequired ? "(required)" : "(optional)"}
              </span>
            </span>
            <span className="tnum text-[11px] font-normal text-ink-3">
              {note.length}/{NOTE_MAX_LENGTH}
            </span>
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            disabled={pending}
            maxLength={NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && noteMissing}
            placeholder={
              noteRequired ? "Tell us what came up" : "Anything the tutor should know"
            }
            className={[
              "w-full rounded-md border bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3 disabled:opacity-50",
              touched && noteMissing ? "border-danger" : "border-line",
            ].join(" ")}
          />
          {touched && noteMissing && (
            <p className="mt-1 text-[12px] text-danger">
              Please say what came up when choosing “Other”.
            </p>
          )}
        </div>
      </div>

      {error && (
        // `role="alert"` so a rejection is announced rather than silently
        // appearing below the fold on a phone.
        <p
          id={errorId}
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger"
        >
          <span aria-hidden="true" className="mt-px font-semibold">
            !
          </span>
          <span>{error}</span>
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md px-3 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-describedby={error ? errorId : undefined}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending && <Spinner />}
          {pending ? "Sending…" : "Send request"}
        </button>
      </div>
    </form>
  );
}

/**
 * The local ⇄ UTC split, made visible.
 *
 * The brief asks for the parent's local time to be shown while the value is
 * stored in UTC, and for that to be reasoned about rather than merely true. So
 * the form states both: the reading the parent picked, and — in monospace,
 * labelled as what gets stored — the exact instant that will be written.
 *
 * This is not debug output left in by accident. Two hours of my life have gone
 * to a parent insisting they booked 3pm while the database said 09:30Z, and
 * both were right. Showing the stored value next to the displayed one turns
 * that conversation into a screenshot.
 */
function SelectionSummary({
  slot,
  timeZone,
  currentSlotUtc,
}: {
  slot: TimeSlot;
  timeZone: TimeZoneId;
  currentSlotUtc: UtcIsoString;
}) {
  return (
    <div className="mt-4 rounded-md border border-accent-line bg-accent-soft px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-accent">
          Moving to
        </span>
        <span className="tnum text-[13px] font-semibold text-ink">
          {formatInZone(slot.utc, timeZone, {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          })}
        </span>
        <span className="text-[12px] text-ink-2">
          {zoneAbbreviation(slot.utc, timeZone)} · your local time
        </span>
      </div>

      <dl className="mt-2 space-y-0.5 border-t border-accent-line/60 pt-2 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-[86px] shrink-0 text-ink-3">Stored as</dt>
          <dd className="tnum font-mono text-ink-2">{slot.utc}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[86px] shrink-0 text-ink-3">Replacing</dt>
          <dd className="tnum font-mono text-ink-3">{currentSlotUtc}</dd>
        </div>
      </dl>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="spin"
    >
      <circle
        cx="8"
        cy="8"
        r="6.2"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      <path
        d="M14.2 8A6.2 6.2 0 0 0 8 1.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
