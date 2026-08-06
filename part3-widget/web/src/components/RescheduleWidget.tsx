"use client";

import {
  formatInZone,
  type ParentProfile,
  type RescheduleReason,
  type TimeZoneId,
  type TutoringSession,
  type UtcIsoString,
} from "@debe/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { callRequestReschedule } from "@/lib/callable";
import { useDetectedTimeZone, useNow } from "@/lib/hooks";

import { RescheduleForm } from "./RescheduleForm";
import { SessionCard } from "./SessionCard";
import { TimeZoneBar } from "./TimeZoneBar";

interface RescheduleWidgetProps {
  readonly parent: ParentProfile;
  readonly initialSessions: readonly TutoringSession[];
  /** The server's clock at render time — see `useNow` for why this is a prop. */
  readonly serverNowMs: number;
}

type Submission =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "done"; readonly session: TutoringSession };

export function RescheduleWidget({
  parent,
  initialSessions,
  serverNowMs,
}: RescheduleWidgetProps) {
  const nowMs = useNow(serverNowMs);
  const detectedTimeZone = useDetectedTimeZone();

  const [viewTimeZone, setViewTimeZone] = useState<TimeZoneId>(parent.timeZone);
  const [sessions, setSessions] = useState<readonly TutoringSession[]>(initialSessions);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission>({ state: "idle" });
  const [confirmation, setConfirmation] = useState<TutoringSession | null>(null);

  // One controller per in-flight request. Aborting the previous one means a
  // slow first submit can never land after a fast second one and overwrite it
  // with stale data — and unmounting cancels cleanly instead of setting state
  // on a component that is gone.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const handleSubmit = useCallback(
    async (
      session: TutoringSession,
      input: {
        newSlotUtc: UtcIsoString;
        reason: RescheduleReason;
        note: string;
      },
    ) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setSubmission({ state: "pending" });

      try {
        // `callRequestReschedule` resolves for every outcome except a
        // deliberate abort — network failure, timeout, malformed body and
        // protocol error all come back as typed failures. So there is exactly
        // one thing this catch has to handle, and no unhandled rejection can
        // escape.
        const response = await callRequestReschedule(
          {
            sessionId: session.id,
            newSlotUtc: input.newSlotUtc,
            reason: input.reason,
            ...(input.note === "" ? {} : { note: input.note }),
            // Recorded for support, not used for validation — the server
            // re-derives everything from the UTC instant.
            requestedFromTimeZone: viewTimeZone,
          },
          controller.signal,
        );

        if (controller.signal.aborted) return;

        if (!response.success) {
          setSubmission({ state: "error", message: response.error });
          return;
        }

        setSessions((current) =>
          current.map((candidate) =>
            candidate.id === response.session.id ? response.session : candidate,
          ),
        );
        setSubmission({ state: "done", session: response.session });
        setConfirmation(response.session);
        setOpenSessionId(null);
      } catch (error) {
        // Only reachable via abort, which is not a failure to report.
        if (controller.signal.aborted) return;
        setSubmission({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "Something went wrong. Please try again.",
        });
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [viewTimeZone],
  );

  const upcoming = sessions.slice(0, 3);

  return (
    <section
      className="rounded-xl border border-line bg-paper"
      aria-labelledby="widget-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-4 py-4 sm:px-5">
        <div>
          <h2
            id="widget-heading"
            className="text-[17px] font-semibold tracking-tight text-ink"
          >
            Upcoming sessions
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {parent.name} · next {upcoming.length} for{" "}
            {upcoming[0]?.studentName ?? "your child"}
          </p>
        </div>

        <TimeZoneBar
          profileTimeZone={parent.timeZone}
          viewTimeZone={viewTimeZone}
          detectedTimeZone={detectedTimeZone}
          onChange={setViewTimeZone}
        />
      </header>

      {confirmation && (
        <p
          role="status"
          className="mx-4 mt-4 flex items-start gap-2 rounded-md border border-accent-line bg-accent-soft px-3 py-2.5 text-[13px] leading-relaxed text-ink sm:mx-5"
        >
          <CheckIcon />
          <span>
            Request sent. {confirmation.teacherName} has been asked to move{" "}
            <span className="font-medium">{confirmation.subject}</span> to{" "}
            <span className="tnum font-medium">
              {formatInZone(confirmation.startsAtUtc, viewTimeZone, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              })}
            </span>
            . You’ll get an email once it’s confirmed.
          </span>
        </p>
      )}

      {upcoming.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-ink-2 sm:px-5">
          No upcoming sessions.
        </p>
      ) : (
        <ul className="space-y-2.5 p-4 sm:p-5">
          {upcoming.map((session) => {
            const expanded = openSessionId === session.id;
            return (
              <SessionCard
                key={session.id}
                session={session}
                timeZone={viewTimeZone}
                nowMs={nowMs}
                expanded={expanded}
                onToggle={() => {
                  setOpenSessionId(expanded ? null : session.id);
                  setSubmission({ state: "idle" });
                  setConfirmation(null);
                }}
              >
                <RescheduleForm
                  session={session}
                  timeZone={viewTimeZone}
                  nowMs={nowMs}
                  pending={submission.state === "pending"}
                  error={
                    submission.state === "error" ? submission.message : null
                  }
                  onCancel={() => {
                    setOpenSessionId(null);
                    setSubmission({ state: "idle" });
                  }}
                  onSubmit={(input) => {
                    // Fire-and-forget is fine *here* specifically because
                    // handleSubmit cannot reject: every failure path inside it
                    // ends in setState. Attaching a .catch would be dead code
                    // pretending to be diligence.
                    void handleSubmit(session, input);
                  }}
                />
              </SessionCard>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-accent"
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="m5 8.2 2.1 2.1L11.2 6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
