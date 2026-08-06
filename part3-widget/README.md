# Part 3 — Session Reschedule Widget

A parent-facing widget showing a student's next three tutoring sessions, each with a reschedule request that goes through a real `requestReschedule` Cloud Function.

```bash
cd part3-widget
npm install
npm run dev        # http://localhost:3000
```

No Firebase project, no API keys, no `.env`. `npm run verify` runs typecheck, lint and 90 tests.

---

## What it looks like

![The parent's next three sessions](docs/screenshots/01-upcoming-sessions.png)

*Times render in the zone on the parent's account. Nothing here stores a wall clock — each session is an instant, formatted per viewer.*

![The 2-hour lead-time lock-out](docs/screenshots/02-lead-time-lockout.png)

*The lock-out, viewed in `America/New_York` where it is currently mid-afternoon — so the amber band is real, not staged with a faked clock. Grey struck = already passed. **Amber** struck = inside the two-hour window. White = bookable. The banner says how many and why, because a row of dead buttons with no explanation reads as a broken app.*

![Local time shown, UTC stored](docs/screenshots/03-local-time-and-utc.png)

*The whole local/UTC decision in one panel: `17:30 GMT-4` is what the parent picked, `2026-08-06T21:30:00.000Z` is what gets written. Change the zone dropdown and the top line moves while `Stored as` does not.*

<details>
<summary>Request sent, dark mode, and narrow viewport</summary>

![Confirmation after a successful request](docs/screenshots/04-request-sent.png)

*The session moves to `reschedule_requested`, not `confirmed` — a tutor has to agree before the slot is actually theirs.*

![Dark mode](docs/screenshots/05-dark-mode.png)

*Note what is **not** here: the "your device is in another timezone" prompt. The browser reports `Asia/Calcutta` and the account says `Asia/Kolkata` — the same zone under a legacy IANA alias. Comparing the strings offered a parent in India the chance to switch from their timezone to their timezone; `zonesRenderIdentically()` compares offsets across the year instead.*

![Narrow viewport](docs/screenshots/06-mobile.png)

*390px wide, zero horizontal overflow — asserted in the capture script, not eyeballed.*

</details>

---

## The two constraints the brief singles out

### 1. Local time shown, UTC stored

Three rules, enforced by the type system rather than by discipline:

**Instants are stored; wall clocks are rendered.** A session has `startsAtUtc` and no timezone field. It does not happen "at 3pm" — it happens at an instant, and the parent, the student and the tutor may each be looking at that instant from a different zone. Which zone to render in is a per-viewer presentation decision, made at the last moment by `formatInZone()`.

**The two kinds of string are different types.** [`UtcIsoString`](shared/src/types.ts) and `LocalWallClock` are both `string` at runtime, but distinct to the compiler:

```ts
export type UtcIsoString  = string & { readonly [utcIsoBrand]: "UtcIsoString" };
export type LocalWallClock = string & { readonly [wallClockBrand]: "LocalWallClock" };
```

`<input type="datetime-local">` gives you `"2026-08-08T15:00"` — a wall clock with no zone. Every scheduling bug I have had to debug in production has been someone treating that as an instant: `new Date("2026-08-08T15:00")` parses in the *runtime's* local zone, which is UTC on a server and something else on a laptop. The booking lands hours off, but only for users who aren't in the server's zone — so it survives every test you run at your desk. The brands make [`wallClockToUtc()`](shared/src/time.ts) the only way across, and skipping it a compile error.

**The server renders in the account's zone, not the browser's.** Reading `Intl.DateTimeFormat().resolvedOptions().timeZone` during render is a hydration bug: the server can't know the device zone, so it renders in the container's, the browser re-renders in the parent's, and React discards the server HTML — silently, in production. So `ParentProfile.timeZone` is authoritative for the first paint, and the device zone is detected *after* mount and used only to offer a switch. That is also the better product behaviour: a parent travelling for a week has not moved their child's lessons to a new timezone.

The form prints the instant it is about to store underneath the local time it is showing:

```
Moving to   Sat 8 Aug, 14:30   GMT+5:30 · your local time
Stored as   2026-08-08T09:00:00.000Z
Replacing   2026-08-06T19:00:00.000Z
```

Not debug output. Two hours of my life have gone to a parent insisting they booked 3pm while the database said 09:30Z, and both were right.

**DST is handled rather than assumed.** A wall clock plus a zone is not always one instant. On the day New York springs forward, 02:30 never happens; on the day it falls back, 01:30 happens twice. `wallClockToUtc` samples the offset a day either side, keeps the candidates that round-trip, and returns a discriminated union — `exact`, `dst-gap` or `dst-ambiguous` — instead of silently picking one. Slots are generated by iterating the **wall clock** and converting each reading independently, so a reading inside a gap is dropped and the day simply has fewer slots.

The test that pins this down hardest: `generateDaySlots` returns **zero** slots for `2011-12-30` in `Pacific/Apia` — the day Samoa skipped crossing the date line. Nothing special-cases it.

### 2. The 2-hour lead-time lock-out

`RESCHEDULE_LEAD_TIME_MS` lives in [`shared/src/policy.ts`](shared/src/policy.ts), imported by both the UI and the function. If the UI greyed out slots on a 2-hour rule while the server enforced 90 minutes, the app would offer a slot and then refuse it.

The picker is a **discrete slot grid, not `<input type="datetime-local">`**, and that is a deliberate call. A native datetime input cannot express "these particular times are unavailable" — `min` gives you a floor and nothing else, so a parent can still type 03:15 on a day the tutor doesn't work. Its `min` is also a wall-clock string with no zone, compared in the device's local terms, so it lands in the wrong place the moment the device zone and the displayed zone diverge. You cannot express "two hours from now, in UTC" to that attribute at all.

Slots render in three states, and the locked ones say why — in the tooltip, in the `aria-label`, and in a banner:

| | |
|---|---|
| ~~08:00~~ grey | Already passed |
| ~~10:30~~ **amber** | Less than 2 hours' notice — the policy |
| 12:30 | Bookable |

The client's check is a courtesy that saves a round trip. The server runs the identical function against **its own clock** — `'enforces lead time against the SERVER clock, not the client's'` is a test, because a browser with a wrong system clock greys nothing out. `CLOCK_SKEW_GRACE_MS` (60s) only ever *admits* a borderline slot, so a parent who taps the instant one becomes legal isn't refused for 300ms of latency.

`useNow()` re-reads the clock every 30 seconds, so a slot just outside the window greys itself out while the form is open rather than staying submittable.

---

## Layout

```
part3-widget/
├── shared/          @debe/shared — imported by BOTH web and functions
│   └── src/
│       ├── types.ts               branded time types, the wire contract
│       ├── policy.ts              every tunable number, with its reasoning
│       ├── time.ts                UTC ⇄ wall clock, DST resolution
│       ├── slots.ts               slot generation + the lock-out
│       ├── validateReschedule.ts  pure validator, no clock, no I/O
│       ├── handler.ts             the handler, minus the transport
│       └── mock/                  fixtures + in-memory repository
├── functions/       the real firebase-functions v2 onCall
├── web/             Next.js App Router
│   └── src/
│       ├── app/api/reschedule/    local transport, callable wire protocol
│       ├── components/            widget, card, form, slot picker
│       └── lib/callable.ts        client adapter
└── tests/           90 tests, no emulator
```

**Why a workspace.** The brief asks for shared types between the frontend and the function. Two files that agree today will disagree eventually, so `@debe/shared` is a real package boundary both import — the contract cannot drift without the compiler noticing.

**One handler, two transports.** `createRescheduleHandler(deps)` takes a repository and a clock and knows nothing about HTTP. The Cloud Function wraps it in `onCall`; the Next route handler wraps it in a `POST`. Writing it twice would mean two things to keep in step, and the copy that drifts is always the one you aren't looking at.

**The local route speaks the Firebase callable wire protocol** — request `{ data }`, success `{ result }`, failure `{ error: { status, message } }`. So pointing the client at a deployed function or the emulator is one environment variable, `NEXT_PUBLIC_FUNCTIONS_ORIGIN`, and no calling code changes.

---

## No `any`, and no unhandled rejections

`no-explicit-any` is on, and there is no `any` in the source. The one place the type system would normally be tempted — the incoming request body — is typed `unknown` and narrowed by a real guard, because a `RescheduleRequest` annotation on network input is a comment with extra steps.

`callRequestReschedule` has **no rejecting path**. Offline, DNS failure, timeout, a protocol error, and a 200 carrying the wrong shape all become typed `{ success: false }` values. "No unhandled promise rejections" is then a property of the code rather than a promise in a README — no caller can forget a `.catch`, because there is nothing to catch. `'never rejects, whatever it is given'` is a test.

---

## Verification

```bash
npm run verify      # typecheck (3 workspaces) + lint + 90 tests
```

The tests that carry weight:

| Test | What it defends |
|---|---|
| `gives the same reading two different instants in summer and winter` | 3pm in London is 15:00Z in January, 14:00Z in July |
| `returns nothing for a calendar day that never happened` | Samoa, 30 Dec 2011 |
| `is DST-aware: the same reading maps to different instants across a transition` | proves slots aren't generated by adding fixed milliseconds |
| `enforces lead time against the SERVER clock, not the client's` | the browser's clock is not evidence |
| `gives the same answer for someone else's session as for one that does not exist` | the endpoint can't be used to enumerate session ids |
| `will not let one parent touch another family's session` | IDOR — the descendant of Part 2's bug 2 |
| `recognises the existing slot even when written in another form` | `+05:30` vs `Z` for the same instant |
| `never rejects, whatever it is given` | why the UI has no try/catch |

Also driven end-to-end in Chromium at two clocks — 23:00 (day exhausted → empty state and jump work) and 10:30 pinned (four slots amber-locked, boundary exactly at now + 2h) — with no console errors and no hydration warning against a browser in `Europe/London` and an account in `Asia/Kolkata`.

---

## What I'd do next, honestly

- **Tutor availability is not modelled.** Every 30-minute slot between 08:00 and 21:00 is offered. A real portal intersects the tutor's roster and existing bookings; the slot generator already returns instants, so that is a filter, not a rewrite.
- **The repository is in-memory.** Swapping it for Firestore means implementing one interface. The write should be a transaction for the same reason as Part 2 — two parents claiming one slot concurrently.
- **No optimistic UI.** The form waits for the round trip. Fine at this latency, worth revisiting on mobile.
- **`reschedule_requested` has no tutor-side accept/decline.** The status exists and the session moves to it; nothing consumes it yet.
- **No component tests.** The logic is covered thoroughly and the UI was driven manually in a real browser, but there is no Testing Library suite in CI.
- **`enforceAppCheck` is off**, because this build has no App Check provider. It is a one-word change and belongs on for a public parent portal.
