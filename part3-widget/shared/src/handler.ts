/**
 * `requestReschedule`, minus the transport.
 *
 * The same logic has to run in two places: the real Firebase callable in
 * `functions/`, and the local Next.js route handler that the widget talks to in
 * development. Writing it twice would mean two things to keep in step, and the
 * copy that drifts is always the one you are not currently looking at.
 *
 * So the handler is built here as a plain function over injected dependencies —
 * a session repository and a clock — and each transport is a thin adapter that
 * supplies those and maps the result onto its own error convention:
 *
 *      functions/src/index.ts  ──┐
 *                                ├──▶ createRescheduleHandler(deps)
 *      web/src/app/api/…/route  ──┘
 *
 * Injecting the clock rather than calling `Date.now()` inside is what makes the
 * lead-time rule testable: "a slot 1h59m out is rejected, 2h01m is accepted" is
 * a two-line test, not an exercise in freezing time.
 */

import {
  parseRescheduleRequest,
  validateAgainstSession,
} from "./validateReschedule";
import type {
  RescheduleRequest,
  RescheduleResponse,
  TutoringSession,
} from "./types";

/**
 * Storage, as the handler needs to see it.
 *
 * In-memory in this submission (`functions/src/repository.ts`); a Firestore
 * collection in a real deployment. The handler cannot tell the difference,
 * which is why the whole rule set is unit-testable without an emulator.
 */
export interface SessionRepository {
  /**
   * Note the signature: **the parent id is a required argument**, not a filter
   * applied afterwards. Scope is part of the lookup, so there is no code path
   * that fetches a session first and remembers to check ownership second.
   * Returns `null` for both "no such session" and "not yours" — the caller must
   * not be able to tell those apart.
   */
  findForParent(
    sessionId: string,
    parentId: string,
  ): Promise<TutoringSession | null>;

  applyRescheduleRequest(args: {
    readonly session: TutoringSession;
    readonly request: RescheduleRequest;
    readonly requestedByParentId: string;
    readonly requestedAtMs: number;
  }): Promise<TutoringSession>;
}

export interface HandlerLogger {
  error(message: string, context: Record<string, unknown>): void;
}

export interface RescheduleHandlerDeps {
  readonly repository: SessionRepository;
  /** The server's clock. Injected so tests can pin it. */
  readonly now: () => number;
  readonly logger?: HandlerLogger;
}

export interface AuthenticatedCaller {
  readonly uid: string;
}

export type RescheduleHandler = (
  rawInput: unknown,
  caller: AuthenticatedCaller | null,
) => Promise<RescheduleResponse>;

export function createRescheduleHandler({
  repository,
  now,
  logger,
}: RescheduleHandlerDeps): RescheduleHandler {
  return async function requestReschedule(rawInput, caller) {
    // Auth first, before anything touches the input. A callable function is a
    // public endpoint by default — deploying it puts it on the open internet —
    // and the Admin SDK bypasses Firestore Security Rules entirely, so this
    // check is the only thing in front of the data. Same lesson as bug 2 in
    // Part 2, and the reason it is the first statement in the function.
    if (!caller) {
      return {
        success: false,
        code: "unauthenticated",
        error: "Please sign in to request a reschedule.",
      };
    }

    const parsed = parseRescheduleRequest(rawInput);
    if (!parsed.ok) {
      return { success: false, code: parsed.code, error: parsed.error };
    }

    try {
      // The parent id comes from the verified token, never from the payload.
      // If the client could name the parent, a signed-in user could move
      // another family's lessons by editing one field.
      const session = await repository.findForParent(
        parsed.value.sessionId,
        caller.uid,
      );

      const validated = validateAgainstSession({
        request: parsed.value,
        session,
        nowMs: now(),
      });
      if (!validated.ok) {
        return {
          success: false,
          code: validated.code,
          error: validated.error,
        };
      }

      // `session` is non-null here — `validateAgainstSession` returns
      // `not-found` otherwise — but the compiler can't see across that
      // boundary, so assert it once, narrowly, rather than loosening the type.
      const updated = await repository.applyRescheduleRequest({
        session: session!,
        request: validated.value,
        requestedByParentId: caller.uid,
        requestedAtMs: now(),
      });

      return { success: true, session: updated };
    } catch (error) {
      // Log the detail server-side; return something generic. Storage errors
      // carry document paths and field values, and those must not be handed to
      // an untrusted client.
      logger?.error("requestReschedule failed", {
        sessionId: parsed.value.sessionId,
        parentId: caller.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        code: "internal",
        error: "Something went wrong on our end. Please try again.",
      };
    }
  };
}
