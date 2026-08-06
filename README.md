# Debe Learning — Tech Intern Assessment

Garv Bahl · [github.com/garvbahl37-gif](https://github.com/garvbahl37-gif)

**→ Written answers for all four parts are in [SUBMISSION.md](SUBMISSION.md).**

```
part2-debug/     Part 2 — the buggy Cloud Function, fixed
part3-widget/    Part 3 — the Session Reschedule Widget
SUBMISSION.md    Parts 1–4, written up
```

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
