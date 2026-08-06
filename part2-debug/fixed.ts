// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — FIXED VERSION
//
// Four distinct bugs were present in `original.ts`. Each fix is commented
// inline, directly above the change, with *why it breaks in production* rather
// than just "this was wrong".
//
//   BUG 1 (async/await) — Promises were never awaited. `.get()` returns a
//                         Promise, so `existing.docs` was `undefined` and every
//                         single call threw. The final `.add()` was also
//                         fire-and-forget, which silently drops writes.
//   BUG 2 (security)    — No auth check, and `studentId` was trusted from the
//                         request body. Anyone on the internet could book any
//                         session as any student.
//   BUG 3 (logic)       — The conflict check read `teachers/{id}/bookings`
//                         while the write went to the top-level `bookings`
//                         collection. The guard queried a collection nothing
//                         ever wrote to, so it could never fire. Compounded by
//                         a read-then-write race with no transaction.
//   BUG 4 (typing)      — `data: BookingRequest` was an unchecked assertion
//                         over untrusted network input. TypeScript erases at
//                         runtime, so malformed payloads sailed straight into
//                         Firestore.
//
// A fifth, supporting issue (ISO-string normalisation) is documented at the
// `toCanonicalUtcIso` helper — it is the reason the slot guard would still have
// leaked double-bookings even after bugs 1–3 were fixed.
// ─────────────────────────────────────────────────────────────────────────────

// Import from the explicit `/v1` entrypoint. The bare "firebase-functions"
// import still resolves to the v1 API on SDK v4/v5 but is removed in v6+, so
// pinning the namespace keeps this file from breaking on a routine `npm
// update`. (Signature preserved from the original for a legible diff; the v2
// equivalent is sketched at the bottom of the file.)
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

const bookingsRef = db.collection("bookings");

/** Longest subject string we will persist. Bounds the document size. */
const SUBJECT_MAX_LENGTH = 80;

interface BookingRequest {
  studentId: string;
  teacherId: string;
  slot: string; // ISO datetime string, must carry an explicit UTC offset
  subject: string;
}

/**
 * The wire contract, as a discriminated union rather than
 * `{ success: boolean; message?: string }`. The union makes it impossible for a
 * caller to read `message` on a success, and impossible for us to return a
 * failure without saying why — the compiler enforces both.
 */
type BookSessionResponse =
  | { success: true; bookingId: string }
  | { success: false; message: string };

// ─── BUG 4 (typing) ──────────────────────────────────────────────────────────
// The original signature was `(data: BookingRequest, context)`. That is a lie
// the compiler happily believes: `onCall` hands you whatever JSON the client
// sent, and TypeScript types are erased at runtime, so there is nothing
// checking it. A caller posting `{}` produced a booking object full of
// `undefined`, and the Firestore Node SDK *rejects* `undefined` field values —
// so the write throws deep inside the SDK and the caller gets an opaque
// `INTERNAL` 500 with no idea what they got wrong. Worse, a caller posting
// `{ subject: { $huge: "..." } }` writes an arbitrary nested object into the
// document.
//
// Fix: accept `unknown` and validate at the trust boundary. The type guard is
// the *only* place a `BookingRequest` can come into existence, so past this
// function the static type is actually true.
function parseBookingInput(
  data: unknown,
): Pick<BookingRequest, "teacherId" | "slot" | "subject"> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Request body must be a JSON object.",
    );
  }

  const { teacherId, slot, subject } = data as Record<string, unknown>;

  if (typeof teacherId !== "string" || teacherId.trim() === "") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`teacherId` is required and must be a non-empty string.",
    );
  }
  if (typeof slot !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`slot` is required and must be an ISO-8601 string.",
    );
  }
  if (typeof subject !== "string" || subject.trim() === "") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`subject` is required and must be a non-empty string.",
    );
  }
  if (subject.length > SUBJECT_MAX_LENGTH) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `\`subject\` must be ${SUBJECT_MAX_LENGTH} characters or fewer.`,
    );
  }

  // `teacherId` is interpolated into a Firestore document path further down.
  // Firestore path segments cannot contain "/", and "." / ".." are reserved —
  // rejecting them here stops a crafted id from escaping its collection.
  if (/[/]/.test(teacherId) || teacherId === "." || teacherId === "..") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`teacherId` contains characters that are not valid in a document path.",
    );
  }

  return { teacherId: teacherId.trim(), slot, subject: subject.trim() };
}

/**
 * Collapses any valid ISO-8601 instant to one canonical UTC representation.
 *
 * SUPPORTING BUG: the original compared slots with Firestore `==`, which is a
 * raw string comparison. `2026-08-08T14:00:00Z`, `2026-08-08T14:00:00.000Z` and
 * `2026-08-08T19:30:00+05:30` are the *same instant* but three different
 * strings, so the duplicate guard would have missed the conflict and
 * double-booked the teacher — a real support ticket, not a theoretical one,
 * because different clients serialise dates differently.
 *
 * We also require an explicit offset. Per the ECMAScript spec a date-time
 * string with no designator (`2026-08-08T14:00`) is parsed as *local* time; on
 * a Cloud Functions container "local" happens to be UTC today, but that is an
 * accident of the runtime, not a guarantee. Rejecting ambiguous input is
 * cheaper than debugging a five-and-a-half-hour offset in production.
 */
function toCanonicalUtcIso(raw: string): string {
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  if (!hasExplicitOffset) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`slot` must include an explicit UTC offset (e.g. `Z` or `+05:30`).",
    );
  }

  const epochMs = Date.parse(raw);
  if (Number.isNaN(epochMs)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "`slot` is not a valid ISO-8601 datetime.",
    );
  }

  return new Date(epochMs).toISOString();
}

/** Sentinel used to unwind the transaction on an expected business conflict. */
class SlotUnavailableError extends Error {}

// ─── BUG 1 (async/await) ─────────────────────────────────────────────────────
// The handler was synchronous. `db...get()` returns a `Promise<QuerySnapshot>`,
// so `existing.docs` read a property off a Promise — `undefined` — and
// `undefined.length` threw a TypeError on *every single invocation*. This
// function never worked once; it was a 100% error rate, not an edge case.
//
// The second half of the same bug is subtler and much more dangerous:
// `db.collection("bookings").add(booking)` was never awaited. Cloud Functions
// freezes the container's CPU the moment the handler returns, so an in-flight
// write is not guaranteed to complete. That produces the worst possible
// failure mode — the client is told `{ success: true }` while the booking
// silently never lands. It also "works" on every local test, because the
// emulator keeps the process alive.
export const bookSession = functions.https.onCall(
  async (
    data: unknown,
    context: functions.https.CallableContext,
  ): Promise<BookSessionResponse> => {
    // ─── BUG 2 (security) ────────────────────────────────────────────────────
    // The original never looked at `context`. A callable function's endpoint is
    // public by default — `firebase deploy` puts it on the open internet — so
    // anyone with the project id could `curl` this and write arbitrary
    // documents into Firestore. That is an unauthenticated write endpoint on a
    // billed database: spam bookings, cost amplification, and a data-integrity
    // problem all at once.
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be signed in to book a session.",
      );
    }

    const input = parseBookingInput(data);
    const slotUtc = toCanonicalUtcIso(input.slot);

    // ─── BUG 2, second half (the one that actually matters) ──────────────────
    // Even *with* an auth check, taking `studentId` from the request body is
    // broken: a signed-in parent could book sessions in another family's name
    // by editing one field in the payload. Classic IDOR / identity spoofing.
    //
    // The rule is that identity comes from the verified token, never from the
    // body. `context.auth.uid` is derived from a signature Firebase has already
    // checked, so it cannot be forged by the caller.
    //
    // (A real Debe portal would go one step further and confirm this uid is a
    // guardian of the student being booked for — a parent may legitimately book
    // for several children. That lookup is out of scope here, but the shape is
    // the same: authorise against server-held state, not client claims.)
    const studentId = context.auth.uid;

    // ─── BUG 3 (logic) ───────────────────────────────────────────────────────
    // The guard read `teachers/{teacherId}/bookings` — a *subcollection* — but
    // the write went to the top-level `bookings` collection. Those are two
    // unrelated collections in Firestore; a subcollection is not a view over
    // its parent's siblings. The subcollection was therefore always empty, the
    // guard always passed, and every teacher could be booked into the same slot
    // an unlimited number of times. The check read as correct in review, which
    // is exactly why it survived.
    //
    // Second half of bug 3: even pointed at the right collection, a bare
    // read-then-write is a race. Two parents tapping "Book" inside the same
    // few hundred milliseconds both see zero conflicts and both write. Under
    // load — which for a tutoring portal means the minute a popular slot opens
    // — this reliably double-books. A transaction is what makes the check and
    // the write atomic: Firestore re-runs the closure if anything it read was
    // touched concurrently.
    try {
      const bookingId = await db.runTransaction(async (tx) => {
        const conflict = await tx.get(
          bookingsRef
            .where("teacherId", "==", input.teacherId)
            .where("slot", "==", slotUtc)
            .where("status", "==", "confirmed")
            .limit(1),
        );

        if (!conflict.empty) {
          throw new SlotUnavailableError();
        }

        const docRef = bookingsRef.doc();
        tx.create(docRef, {
          studentId,
          teacherId: input.teacherId,
          slot: slotUtc,
          subject: input.subject,
          status: "confirmed",
          // `new Date()` stamps the *function container's* clock, which is not
          // authoritative and drifts between instances. `serverTimestamp()` is
          // resolved by Firestore itself, so bookings are ordered consistently
          // and a client cannot influence the value.
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: context.auth!.uid,
        });

        return docRef.id;
      });

      return { success: true, bookingId };
    } catch (error) {
      // An expected business outcome, not a fault: return it as data so the UI
      // can render "that slot just went" without a try/catch.
      if (error instanceof SlotUnavailableError) {
        return { success: false, message: "Slot already booked" };
      }

      // A validation error raised inside the transaction body must not be
      // swallowed and relabelled as an internal fault.
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }

      // Anything else is a genuine fault. Log the detail server-side, return a
      // generic message: Firestore error strings can carry document paths and
      // field values, and those should not reach an untrusted client.
      functions.logger.error("bookSession failed", {
        studentId,
        teacherId: input.teacherId,
        slot: slotUtc,
        error,
      });
      throw new functions.https.HttpsError(
        "internal",
        "Could not complete the booking. Please try again.",
      );
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// NOTES FOR REVIEW
//
// • Firestore serves equality-only, multi-field queries by merging its
//   automatic single-field indexes, so the transaction query above needs no
//   composite index. Add one if an `orderBy` is ever introduced.
//
// • An alternative to the transaction is a deterministic document id —
//   `bookings/{teacherId}__{slotUtc}` written with `.create()`, which fails
//   atomically with ALREADY_EXISTS. It is one round trip instead of two and
//   needs no query at all. I chose the transaction because it survives
//   cancel-and-rebook (a released slot must become bookable again, which a
//   uniqueness-by-id scheme blocks until the old document is hard-deleted).
//
// • Callable functions are public endpoints; the `context.auth` check above is
//   the only thing standing in front of the database. Firestore Security Rules
//   do *not* apply here — the Admin SDK bypasses them entirely. That surprises
//   people, and it is why bug 2 is the most serious of the four.
//
// • On the v2 API (`firebase-functions/v2/https`) the same handler is
//   `onCall<unknown>(async (request) => …)` with `request.auth?.uid` and
//   `request.data`. The bugs and their fixes are identical; only the shape of
//   the argument changes. v2 also lets you set `{ enforceAppCheck: true }`,
//   which is worth turning on for a public-facing parent portal.
// ─────────────────────────────────────────────────────────────────────────────
