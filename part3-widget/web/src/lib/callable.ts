/**
 * The client half of the callable contract.
 *
 * Every failure mode is turned into a typed `RescheduleResponse` before it
 * leaves this module. That is what makes "no unhandled promise rejections" a
 * property of the code rather than a promise in a README: `callRequestReschedule`
 * has no rejecting path, so no caller can forget a `.catch`. The UI branches on
 * `success`, and that is the whole error handling story.
 *
 * The failures it has to absorb are more varied than they look:
 *
 *   • the request never arrives (offline, DNS, connection reset)
 *   • it arrives but takes forever (hence the AbortController)
 *   • it returns a protocol error (401, 500)
 *   • it returns 200 with a body that isn't the shape we expect
 *
 * The last one is the one people skip, and it is the one that produces
 * `Cannot read properties of undefined` in production.
 */

import type { RescheduleRequest, RescheduleResponse } from "@debe/shared";

import { DEV_ID_TOKEN } from "./devAuth";

/**
 * Where the function lives.
 *
 * Unset (the default) → the local route handler at `/api/reschedule`.
 * Set → a deployed function or the emulator, e.g.
 *       `http://127.0.0.1:5001/debe-portal/europe-west2`.
 *
 * Both speak the same wire protocol, which is the point of having bothered to
 * implement it properly in the route handler.
 */
const FUNCTIONS_ORIGIN = process.env.NEXT_PUBLIC_FUNCTIONS_ORIGIN;

const ENDPOINT = FUNCTIONS_ORIGIN
  ? `${FUNCTIONS_ORIGIN.replace(/\/$/, "")}/requestReschedule`
  : "/api/reschedule";

/** Long enough for a cold start, short enough that the form isn't hung. */
const TIMEOUT_MS = 12_000;

export async function callRequestReschedule(
  payload: RescheduleRequest,
  signal?: AbortSignal,
): Promise<RescheduleResponse> {
  // Two abort sources — our timeout, and the caller's (a component unmounting,
  // or a second submit superseding the first). `AbortSignal.any` folds them
  // into one so neither is dropped.
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Identity travels in the header, never in the body. Swapping the dev
        // token for `await getIdToken(auth.currentUser)` is the only change
        // needed against real Firebase Auth.
        Authorization: `Bearer ${DEV_ID_TOKEN}`,
      },
      // The callable protocol nests the payload under `data`.
      body: JSON.stringify({ data: payload }),
      signal: combined,
    });
  } catch (error) {
    // The caller aborted deliberately — let that propagate, because it is not a
    // failure and the UI should not render an error for it.
    if (signal?.aborted) throw error;

    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        success: false,
        code: "internal",
        error: "That took too long. Check your connection and try again.",
      };
    }
    return {
      success: false,
      code: "internal",
      error: "We couldn’t reach the server. Check your connection.",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      success: false,
      code: "internal",
      error: "The server sent something we couldn’t read. Please try again.",
    };
  }

  // Protocol error envelope: `{ error: { status, message } }`.
  if (isProtocolError(body)) {
    return {
      success: false,
      code: response.status === 401 ? "unauthenticated" : "internal",
      error: body.error.message,
    };
  }

  // Success envelope: `{ result: … }`.
  if (isResultEnvelope(body) && isRescheduleResponse(body.result)) {
    return body.result;
  }

  return {
    success: false,
    code: "internal",
    error: "The server sent an unexpected response. Please try again.",
  };
}

function isProtocolError(
  value: unknown,
): value is { error: { status: string; message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function isResultEnvelope(value: unknown): value is { result: unknown } {
  return typeof value === "object" && value !== null && "result" in value;
}

/**
 * Validate the response shape before trusting it.
 *
 * The server is ours, so this looks paranoid — until a deploy skew puts an old
 * client in front of a new function, or a proxy returns an HTML error page with
 * a 200. Checking costs four lines and turns a crash into a message.
 */
function isRescheduleResponse(value: unknown): value is RescheduleResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { success?: unknown; error?: unknown };
  if (candidate.success === true) return "session" in value;
  return candidate.success === false && typeof candidate.error === "string";
}
