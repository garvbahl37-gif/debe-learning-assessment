/**
 * Stand-in for Firebase Auth.
 *
 * The brief allows the function to be mocked locally, and wiring a real
 * Firebase project in would add a credentials step without demonstrating
 * anything the boundary code doesn't already show. So this module is the seam
 * where `admin.auth().verifyIdToken()` goes, and it is kept deliberately small
 * and deliberately loud about what it is.
 *
 * What it preserves — and the reason it exists at all rather than the server
 * just assuming a parent id:
 *
 *   • the caller's identity arrives in an `Authorization` header, not the body;
 *   • a request with no header is **unauthenticated** and is refused;
 *   • the parent id used for the ownership check comes from the verified token
 *     and nowhere else.
 *
 * Those are the three properties bug 2 in Part 2 got wrong, so they are the
 * three worth keeping honest even in a mock.
 */

import { MOCK_PARENT } from "@debe/shared/mock";

const DEV_TOKEN_PREFIX = "dev:";

export interface VerifiedCaller {
  readonly uid: string;
}

/** The token the browser sends. In production: a real Firebase ID token. */
export const DEV_ID_TOKEN = `${DEV_TOKEN_PREFIX}${MOCK_PARENT.id}`;

/**
 * Verify an `Authorization: Bearer …` header.
 *
 * Production body:
 *
 *   const decoded = await admin.auth().verifyIdToken(token);
 *   return { uid: decoded.uid };
 *
 * Everything downstream — the handler, the repository, the ownership check —
 * is already written against the verified result, so that swap is genuinely
 * the whole change.
 */
export function verifyAuthorizationHeader(
  header: string | null,
): VerifiedCaller | null {
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith(DEV_TOKEN_PREFIX)) return null;

  const uid = token.slice(DEV_TOKEN_PREFIX.length);
  return uid === MOCK_PARENT.id ? { uid } : null;
}
