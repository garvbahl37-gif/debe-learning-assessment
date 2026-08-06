/**
 * Local transport for `requestReschedule`.
 *
 * This route is NOT a second implementation of the feature. It imports the same
 * `createRescheduleHandler` from `@debe/shared` that the Cloud Function in
 * `functions/src/index.ts` does, and its only job is to speak HTTP.
 *
 * It speaks the **Firebase callable wire protocol** specifically — request
 * `{ data }`, success `{ result }`, failure `{ error: { status, message } }`
 * with a matching HTTP status. That is a small amount of extra care that buys
 * something concrete: `web/src/lib/callable.ts` can be pointed at a deployed
 * function, or at the emulator, by changing one environment variable, and no
 * calling code changes. A hand-rolled `{ ok: true }` shape would have to be
 * unpicked the day this is deployed for real.
 */

import { NextResponse } from "next/server";

import {
  createRescheduleHandler,
  type RescheduleErrorCode,
} from "@debe/shared";
import { getSessionStore } from "@debe/shared/mock";

import { verifyAuthorizationHeader } from "@/lib/devAuth";

const handleReschedule = createRescheduleHandler({
  repository: getSessionStore(),
  now: () => Date.now(),
  logger: {
    error: (message, context) => console.error(message, context),
  },
});

/** Callable protocol status strings, and the HTTP code each maps to. */
const PROTOCOL_STATUS: Readonly<
  Record<RescheduleErrorCode, { status: string; http: number }>
> = {
  unauthenticated: { status: "UNAUTHENTICATED", http: 401 },
  "invalid-argument": { status: "INVALID_ARGUMENT", http: 400 },
  "not-found": { status: "NOT_FOUND", http: 404 },
  "session-not-reschedulable": { status: "FAILED_PRECONDITION", http: 400 },
  "slot-unchanged": { status: "INVALID_ARGUMENT", http: 400 },
  "slot-in-past": { status: "INVALID_ARGUMENT", http: 400 },
  "lead-time-violation": { status: "FAILED_PRECONDITION", http: 400 },
  "slot-outside-booking-window": { status: "OUT_OF_RANGE", http: 400 },
  internal: { status: "INTERNAL", http: 500 },
};

export async function POST(request: Request): Promise<NextResponse> {
  const caller = verifyAuthorizationHeader(request.headers.get("authorization"));

  // Parse defensively. A malformed body is a 400 with a useful message, not an
  // unhandled rejection that takes the route down with a 500 — the brief asks
  // for no unhandled promise rejections, and this is where the first one would
  // otherwise appear.
  let envelope: unknown;
  try {
    envelope = await request.json();
  } catch {
    return NextResponse.json(
      { error: { status: "INVALID_ARGUMENT", message: "Body must be JSON." } },
      { status: 400 },
    );
  }

  // The callable protocol nests the payload under `data`. Unwrapping it here —
  // rather than accepting either shape — keeps this route honest about which
  // protocol it is implementing.
  const payload =
    typeof envelope === "object" && envelope !== null && "data" in envelope
      ? (envelope as { data: unknown }).data
      : undefined;

  const result = await handleReschedule(payload, caller);

  if (result.success) {
    return NextResponse.json({ result });
  }

  // Same split as the deployed function: business outcomes resolve so the form
  // can render them inline; faults and auth failures come back as protocol
  // errors so the client's catch path and monitoring both see them.
  if (result.code === "internal" || result.code === "unauthenticated") {
    const mapped = PROTOCOL_STATUS[result.code];
    return NextResponse.json(
      { error: { status: mapped.status, message: result.error } },
      { status: mapped.http },
    );
  }

  return NextResponse.json({ result });
}
