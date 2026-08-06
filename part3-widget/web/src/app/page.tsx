/**
 * The parent portal page.
 *
 * A Server Component. It reads the sessions on the server and hands them down
 * as props, so the first paint is real content rather than a spinner waiting on
 * a fetch — which is the whole reason to reach for the App Router here.
 *
 * Two things are passed deliberately:
 *
 *   • `serverNowMs` — the server's clock, used for the first render so server
 *     and client markup match. The widget switches to the browser's clock after
 *     mount. See `useNow`.
 *   • `parent.timeZone` — the zone on the account, which is what the first
 *     paint renders in. The device's zone is not knowable on the server, so
 *     anything derived from it has to wait for the client.
 */

import { MOCK_PARENT, getSessionStore } from "@debe/shared/mock";

import { RescheduleWidget } from "@/components/RescheduleWidget";

// The mock store lives in process memory, so this page must never be
// prerendered at build time or every visitor would see the same frozen clock.
export const dynamic = "force-dynamic";

/**
 * Read the request-scoped data.
 *
 * Split out of the component rather than inlined, because `Date.now()` is
 * impure and a component body is supposed to be idempotent — React's lint says
 * so, and it is right even though a Server Component happens to render once per
 * request. Loading data in a function and rendering from the result keeps the
 * component a pure function of its inputs, which is also what makes the clock
 * injectable everywhere else in this codebase.
 *
 * In production this is where the Firestore query goes, and it is already the
 * right shape for it.
 */
async function loadPortal() {
  const nowMs = Date.now();
  return {
    nowMs,
    sessions: getSessionStore().listUpcoming(MOCK_PARENT.id, nowMs, 3),
  };
}

export default async function ParentPortalPage() {
  const { nowMs, sessions } = await loadPortal();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-7">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-full bg-accent"
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">
            Debe · Parent portal
          </span>
        </div>
        <h1 className="mt-2.5 text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[30px]">
          Your child’s tutoring schedule
        </h1>
        <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-ink-2">
          Times are shown in your local zone and stored in UTC. Reschedules need
          at least two hours’ notice so your tutor has time to prepare.
        </p>
      </header>

      <RescheduleWidget
        parent={MOCK_PARENT}
        initialSessions={sessions}
        serverNowMs={nowMs}
      />

      <footer className="mt-8 text-[12px] leading-relaxed text-ink-3">
        Part 3 of the Debe Learning tech intern assessment. The reschedule
        request is validated by{" "}
        <code className="font-mono text-[11px] text-ink-2">
          requestReschedule
        </code>
        , which runs the same rules here and as a deployed Cloud Function.
      </footer>
    </main>
  );
}
