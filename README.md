# Debe Learning — Tech Intern Assessment

Garv Bahl · [github.com/garvbahl37-gif](https://github.com/garvbahl37-gif)

**→ Written answers for all four parts are in [SUBMISSION.md](SUBMISSION.md).**

```
part2-debug/     Part 2 — the buggy Cloud Function, fixed
part3-widget/    Part 3 — the Session Reschedule Widget
SUBMISSION.md    Parts 1–4, written up
```

## Part 3 — the widget

![A parent's next three tutoring sessions](part3-widget/docs/screenshots/01-upcoming-sessions.png)

Each session stores an **instant**, never a wall clock, and renders in the zone on the parent's account.

![The 2-hour lead-time lock-out](part3-widget/docs/screenshots/02-lead-time-lockout.png)

The lead-time policy, viewed in `America/New_York` where it is currently mid-afternoon — so the amber band is real rather than staged with a faked clock. Grey struck through = already passed. **Amber** = inside the two-hour window. White = bookable. The banner says how many and why, because thirteen dead buttons with no explanation reads as a broken app rather than a policy.

![Local time shown, UTC stored](part3-widget/docs/screenshots/03-local-time-and-utc.png)

The whole local/UTC decision in one panel. `17:30 GMT-4` is what the parent picked; `2026-08-06T21:30:00.000Z` is what gets written. Change the zone dropdown and the top line moves while `Stored as` does not.

<details>
<summary><b>More</b> — request sent, dark mode, mobile</summary>

![Confirmation after a successful request](part3-widget/docs/screenshots/04-request-sent.png)

The session moves to `reschedule_requested`, not `confirmed` — a tutor has to agree before the slot is actually theirs.

![Dark mode](part3-widget/docs/screenshots/05-dark-mode.png)

Note what is **not** here: the "your device is in another timezone" prompt. The browser reports `Asia/Calcutta` while the account says `Asia/Kolkata` — one zone under a legacy IANA alias. Comparing the strings offered a parent in India the chance to switch from their timezone to their timezone; `zonesRenderIdentically()` compares offsets across the year instead.

![Narrow viewport](part3-widget/docs/screenshots/06-mobile.png)

390px wide, zero horizontal overflow — asserted by the capture script, not eyeballed.

</details>

Full reasoning in [`part3-widget/README.md`](part3-widget/README.md).

## Running it

**Part 3 — the widget.** No Firebase project, no API keys, no `.env`.

```bash
cd part3-widget
npm install
npm run dev        # http://localhost:3000
npm run verify     # typecheck × 3 workspaces + lint + 90 tests
```

**Part 2 — the debugging round.** `prove-bugs` runs `tsc` against both files and asserts that the original fails to compile and the fix does not:

```bash
cd part2-debug
npm install
npm run prove-bugs
```

## The short version

**Part 2** has four bugs, one per category the brief names. The one worth the most is the security bug: a deployed callable is a public internet endpoint, and the Admin SDK bypasses Firestore Security Rules entirely, so `context.auth` was the only thing standing between the open internet and a billed database — and it wasn't there. The one that reveals the most is the missing `await`, because `tsc` catches it, which means the real root cause is that there was no typecheck in CI.

**Part 3** is a parent-facing widget over a real `requestReschedule` Cloud Function. Three npm workspaces so the frontend and the function import the same types from one package rather than two copies that agree today. One handler, two transports — the deployed callable and a local Next route handler that speaks the Firebase callable wire protocol, so switching between them is one environment variable.

Sessions store an **instant** and never a wall clock. `UtcIsoString` and `LocalWallClock` are distinct branded types, so handing a `datetime-local` value to something expecting a stored instant is a compile error rather than a booking that lands five and a half hours off for everyone outside the server's timezone. DST is resolved explicitly — `exact | dst-gap | dst-ambiguous` — and the slot generator returns zero slots for the day Samoa skipped crossing the date line.

The 2-hour lead time is one constant in one file, imported by the UI that greys slots out and the server that enforces them, so the app can't offer a slot and then refuse it. The server still re-checks against its own clock, because a browser with a wrong system clock greys nothing out.
