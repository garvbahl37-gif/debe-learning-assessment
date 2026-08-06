"use client";

import {
  formatInZone,
  zoneAbbreviation,
  type SessionStatus,
  type TimeZoneId,
  type TutoringSession,
} from "@debe/shared";

const STATUS_STYLE: Readonly<
  Record<SessionStatus, { label: string; className: string }>
> = {
  confirmed: {
    label: "Confirmed",
    className: "border-accent-line bg-accent-soft text-accent",
  },
  reschedule_requested: {
    label: "Reschedule requested",
    className: "border-warn-line bg-warn-soft text-warn",
  },
  completed: {
    label: "Completed",
    className: "border-line bg-sunken text-ink-3",
  },
  cancelled: {
    label: "Cancelled",
    className: "border-danger-line bg-danger-soft text-danger",
  },
};

interface SessionCardProps {
  readonly session: TutoringSession;
  readonly timeZone: TimeZoneId;
  readonly nowMs: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children?: React.ReactNode;
}

export function SessionCard({
  session,
  timeZone,
  nowMs,
  expanded,
  onToggle,
  children,
}: SessionCardProps) {
  const startsMs = new Date(session.startsAtUtc).getTime();
  const status = STATUS_STYLE[session.status];

  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">
              {session.subject}
            </h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${status.className}`}
            >
              {status.label}
            </span>
          </div>

          <p className="mt-0.5 text-[13px] text-ink-2">
            with {session.teacherName} · {session.durationMinutes} min
          </p>

          <p className="tnum mt-2 text-[15px] font-medium text-ink">
            {/*
              Rendered from the instant, in the viewer's chosen zone — never
              from a stored "3pm". Change the zone control in the header and
              every one of these moves while `startsAtUtc` stays put.
            */}
            {formatInZone(session.startsAtUtc, timeZone, {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })}
          </p>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
            <span>{zoneAbbreviation(session.startsAtUtc, timeZone)}</span>
            <span aria-hidden="true">·</span>
            <RelativeTime startsMs={startsMs} nowMs={nowMs} />
          </p>
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={[
            "shrink-0 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
            expanded
              ? "border-line-strong bg-sunken text-ink-2"
              : "border-line bg-surface text-ink hover:border-accent hover:bg-accent-soft hover:text-accent",
          ].join(" ")}
        >
          {expanded ? "Close" : "Request reschedule"}
        </button>
      </div>

      {expanded && children}
    </li>
  );
}

/**
 * "in 3 hours", "in 2 days".
 *
 * Deliberately coarse. A live-ticking "in 1h 58m 12s" is a distraction and a
 * re-render every second; the precise boundary that actually matters is
 * enforced in the slot picker, where being wrong has consequences.
 */
function RelativeTime({
  startsMs,
  nowMs,
}: {
  startsMs: number;
  nowMs: number;
}) {
  const deltaMinutes = Math.round((startsMs - nowMs) / 60_000);
  const formatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

  const text =
    Math.abs(deltaMinutes) < 60
      ? formatter.format(deltaMinutes, "minute")
      : Math.abs(deltaMinutes) < 60 * 24
        ? formatter.format(Math.round(deltaMinutes / 60), "hour")
        : formatter.format(Math.round(deltaMinutes / (60 * 24)), "day");

  return <span>{text}</span>;
}
