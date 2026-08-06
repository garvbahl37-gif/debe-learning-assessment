/**
 * `requestReschedule` — the Firebase Cloud Function.
 *
 * The brief says this may be stubbed and does not need deploying. It is written
 * as the real callable anyway, because the interesting part of a Cloud Function
 * is not the business logic — that lives in `@debe/shared` and is unit-tested
 * without any Firebase at all — it is the **boundary**: who is the caller,
 * what did they actually send, and what may leak back out in an error.
 *
 * So this file is deliberately thin. It does four things and nothing else:
 *
 *   1. establishes who is calling (`request.auth`),
 *   2. hands the raw, untrusted payload to the shared handler,
 *   3. maps the handler's typed failure codes onto `HttpsError` codes,
 *   4. keeps internal error detail on the server.
 *
 * Everything else is in `@debe/shared`, which is also what the local Next.js
 * route handler in `web/src/app/api/reschedule/route.ts` calls — one
 * implementation of the rules, two transports.
 *
 * ── Running it for real ─────────────────────────────────────────────────────
 *
 *   npm run build --workspace functions
 *   firebase emulators:start --only functions
 *
 * then point the web app at it by setting
 * `NEXT_PUBLIC_FUNCTIONS_ORIGIN=http://127.0.0.1:5001/<project>/us-central1`.
 * See `web/src/lib/callable.ts`, which already reads that variable.
 */

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";

import {
  createRescheduleHandler,
  type RescheduleErrorCode,
  type RescheduleResponse,
} from "@debe/shared";
import { getSessionStore } from "@debe/shared/mock";

setGlobalOptions({
  // Pin the region. The default (`us-central1`) is a surprising place for a
  // UK/India tutoring portal's data to live, and the round trip shows up as a
  // laggy form. Pinning it explicitly also stops a second function being
  // deployed somewhere else by accident.
  region: "europe-west2",
  // Fluid concurrency: a reschedule is almost entirely I/O wait, so one
  // instance can serve many callers. Keeps cold starts and cost down.
  maxInstances: 10,
});

const handleReschedule = createRescheduleHandler({
  // Swap this line for a Firestore-backed `SessionRepository` and nothing else
  // in the function changes — that is the whole reason the handler takes a
  // repository rather than reaching for `admin.firestore()` itself.
  repository: getSessionStore(),
  now: () => Date.now(),
  logger: { error: (message, context) => logger.error(message, context) },
});

/**
 * Maps our domain failure codes onto the callable protocol's status codes.
 *
 * Worth being deliberate about: `invalid-argument` tells a client "don't retry,
 * fix the request", while `internal` tells it "this might work next time".
 * Returning the wrong one produces either a retry storm or a form that gives up
 * on a transient blip.
 */
const HTTPS_ERROR_CODE: Readonly<
  Record<RescheduleErrorCode, ConstructorParameters<typeof HttpsError>[0]>
> = {
  unauthenticated: "unauthenticated",
  "invalid-argument": "invalid-argument",
  "not-found": "not-found",
  "session-not-reschedulable": "failed-precondition",
  "slot-unchanged": "invalid-argument",
  "slot-in-past": "invalid-argument",
  "lead-time-violation": "failed-precondition",
  "slot-outside-booking-window": "out-of-range",
  internal: "internal",
};

export const requestReschedule = onCall(
  {
    // A parent portal is a public target. App Check makes it materially harder
    // to hammer this endpoint from a script rather than the real app.
    // Off here because the assessment build has no App Check provider
    // configured; it is a one-word change, and it belongs on in production.
    enforceAppCheck: false,
    cors: true,
  },
  // The payload is typed `unknown`, not `RescheduleRequest`. A callable hands
  // you whatever JSON the client sent; annotating it as the type you *hope* for
  // is the typing bug from Part 2, and the compiler will happily believe you.
  // The shared parser narrows it properly.
  async (request: CallableRequest<unknown>): Promise<RescheduleResponse> => {
    const caller = request.auth ? { uid: request.auth.uid } : null;

    const result = await handleReschedule(request.data, caller);

    if (result.success) {
      return result;
    }

    // Two shapes of failure, treated differently on purpose.
    //
    // Business outcomes the UI should render inline — "that slot is inside the
    // 2-hour window", "you already have that time" — come back as a resolved
    // `{ success: false, error }`. Making the client catch an exception to read
    // a validation message means every caller needs a try/catch to render a
    // form error, and one of them will forget.
    //
    // Genuine faults are thrown, so they surface as errors in monitoring rather
    // than as a 200 nobody looks at.
    if (result.code === "internal") {
      // `result.error` is already the generic message; the detail was logged
      // server-side by the handler. Firestore error strings carry document
      // paths and field values and must not reach an untrusted client.
      throw new HttpsError(HTTPS_ERROR_CODE.internal, result.error);
    }

    if (result.code === "unauthenticated") {
      throw new HttpsError("unauthenticated", result.error);
    }

    return result;
  },
);
