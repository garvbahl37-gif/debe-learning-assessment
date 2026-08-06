# Part 2 — Debugging Round

`bookSession` as given has **four distinct bugs**, one from each category the brief names: async/await, security, logic, and typing. There is also a fifth, supporting issue that would have kept the slot guard broken even after the first four were fixed.

| # | Category | What's wrong | Why it matters in production |
|---|---|---|---|
| 1 | **async/await** | `.get()` is never awaited, so `existing` is a `Promise` and `existing.docs` is `undefined`. `undefined.length` throws. Separately, the final `.add()` is fire-and-forget. | The function had a **100% error rate** — it never worked once, for anybody. And the unawaited write is the nastier half: Cloud Functions freezes the container's CPU when the handler returns, so the booking can silently never land while the client is told `{ success: true }`. It passes locally, because the emulator keeps the process alive. |
| 2 | **security** | `context` is never inspected, and `studentId` is read straight out of the request body. | A deployed callable is a **public internet endpoint**, and the Admin SDK **bypasses Firestore Security Rules entirely** — so this is an unauthenticated write straight into a billed database. Even once you add an auth check, trusting `studentId` from the body lets any signed-in parent book in another family's name (IDOR). |
| 3 | **logic** | The conflict check queries the `teachers/{id}/bookings` **subcollection**; the write goes to the **top-level** `bookings` collection. | The guard reads a collection nothing ever writes to, so it is always empty and can never fire — every teacher can be booked into the same slot without limit. It *reads* as correct, which is why it survives review. Compounded by a read-then-write race: two parents tapping "Book" within the same few hundred ms both see zero conflicts and both write. |
| 4 | **typing** | `data: BookingRequest` is an unchecked assertion over untrusted network input. | TypeScript erases at runtime. `{}` produces a document full of `undefined`, which the Firestore Node SDK **rejects** — so the caller gets an opaque `INTERNAL` 500 instead of a useful validation message. A nested object in `subject` gets written verbatim. |
| 5 | *(supporting)* | Slots are compared with Firestore `==`, a **raw string** comparison. | `…T14:00:00Z`, `…T14:00:00.000Z` and `…T19:30:00+05:30` are the same instant serialised three ways. Different clients serialise differently, so the duplicate guard leaks double-bookings even when pointed at the right collection. `fixed.ts` normalises every slot to one canonical UTC form before it is stored or compared. |

## The root cause behind bug 1

Bug 1 is not a subtle runtime-only problem — **`tsc` catches it**. That tells you something more useful than the bug itself: this code was committed without a typecheck in CI. One bug is a mistake; shipping a bug the compiler already found is a process gap.

`npm run prove-bugs` demonstrates exactly that, rather than asking you to take it on trust:

```bash
npm install
npm run prove-bugs
```

```
→ Claim 1: original.ts must FAIL to type-check
  ✓ tsc rejected it, as expected:
      original.ts(35,16): error TS2339: Property 'docs' does not exist on
        type 'Promise<QuerySnapshot<DocumentData, DocumentData>>'.
→ Claim 2: fixed.ts must type-check cleanly
  ✓ fixed.ts compiles under strict mode.
Both claims hold.
```

It also surfaces a bonus find: on `firebase-functions` v6 the bare `from "firebase-functions"` import resolves to the **v2** API, whose handler signature is `(request)`, not `(data, context)`. `fixed.ts` imports from `firebase-functions/v1` explicitly so a routine `npm update` can't silently change the contract.

## Fixes applied in `fixed.ts`

- `async` handler; every Promise awaited.
- `context.auth` required; **`studentId` derived from `context.auth.uid`**, never the body.
- Runtime validation at the trust boundary — `data: unknown` narrowed by a type guard that is the only place a `BookingRequest` can come into existence.
- Conflict check and write moved into **one collection** and wrapped in `db.runTransaction`, making check-and-write atomic.
- Slots normalised to canonical UTC ISO; ambiguous strings without an explicit offset rejected.
- `createdAt` uses `FieldValue.serverTimestamp()` rather than the container's clock.
- `HttpsError` for exceptional cases (unauthenticated, invalid argument); a typed `{ success: false, message }` for the *expected* business outcome of a taken slot. Internal Firestore error strings are logged server-side, never returned — they carry document paths and field values.

## Files

| File | |
|---|---|
| [`original.ts`](original.ts) | Verbatim from the brief, unmodified so the diff is legible. |
| [`fixed.ts`](fixed.ts) | The fix, with a comment above each change explaining the production failure it prevents. |
| [`scripts/prove-bugs.mjs`](scripts/prove-bugs.mjs) | Runs `tsc` against both and asserts the expected outcomes. |
