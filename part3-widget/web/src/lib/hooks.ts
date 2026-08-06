"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Two values the server and the browser legitimately disagree about: what time
 * it is, and which timezone the device is in.
 *
 * Both are read with `useSyncExternalStore` rather than `useState` +
 * `useEffect`. That is not ceremony — it is the API React provides for exactly
 * this shape of problem, an external mutable source whose server snapshot
 * differs from its client one. The `getServerSnapshot` argument is the whole
 * point: React uses it for SSR *and* for the hydrating render, then switches to
 * the live client value afterwards. Markup matches, no mismatch, no flash.
 *
 * The `useState` + `useEffect` version of this works, but sets state during the
 * commit phase on every mount, which React 19's compiler lint correctly objects
 * to as a cascading render.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The clock
// ─────────────────────────────────────────────────────────────────────────────

interface ClockStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
}

/**
 * One shared ticker per interval.
 *
 * `getSnapshot` has to return a *cached* value — React compares snapshots with
 * `Object.is`, so returning a fresh `Date.now()` on every call would report a
 * change on every render and loop forever. The snapshot only moves when the
 * interval fires.
 */
function createClockStore(intervalMs: number): ClockStore {
  let snapshot = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      timer ??= setInterval(() => {
        snapshot = Date.now();
        for (const listener of listeners) listener();
      }, intervalMs);

      return () => {
        listeners.delete(onChange);
        // Last subscriber gone — stop the timer rather than leaving it running
        // for the life of the tab.
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}

const clockStores = new Map<number, ClockStore>();

function clockStoreFor(intervalMs: number): ClockStore {
  let store = clockStores.get(intervalMs);
  if (!store) {
    store = createClockStore(intervalMs);
    clockStores.set(intervalMs, store);
  }
  return store;
}

/**
 * The current time, safe to render on the server.
 *
 * The first render — server and hydration both — uses the timestamp the server
 * passed down, so the markup is identical. After hydration it is the browser's
 * real clock, re-read every 30 seconds.
 *
 * That interval is not decoration. Slot availability is defined relative to
 * *now*, so a slot sitting just outside the 2-hour window ages into it while
 * the parent is looking at the page. Re-reading means the picker greys that
 * slot out on its own, instead of leaving something submittable that the server
 * is about to reject.
 */
export function useNow(serverNowMs: number, intervalMs = 30_000): number {
  const store = useMemo(() => clockStoreFor(intervalMs), [intervalMs]);
  const getServerSnapshot = useCallback(() => serverNowMs, [serverNowMs]);

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    getServerSnapshot,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The device timezone
// ─────────────────────────────────────────────────────────────────────────────

/** Never changes within a page life, so subscribing is a no-op. */
const noopSubscribe = () => () => {};

let detectedTimeZone: string | null | undefined;

function getDetectedTimeZone(): string | null {
  // Cached, for the same `Object.is` reason as the clock, and because
  // constructing a formatter on every render would be wasteful.
  if (detectedTimeZone === undefined) {
    try {
      detectedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      // Locked-down or ancient runtime. The account's zone stays authoritative,
      // which is a perfectly good outcome — it just means no mismatch notice.
      detectedTimeZone = null;
    }
  }
  return detectedTimeZone;
}

/**
 * The zone the browser thinks it is in — `null` on the server and during
 * hydration.
 *
 * That `null` is the point, not a limitation. The server has no way to know the
 * device's zone, so anything derived from it must not appear in the initial
 * HTML. Returning `null` from `getServerSnapshot` makes that impossible to
 * forget.
 */
export function useDetectedTimeZone(): string | null {
  return useSyncExternalStore(noopSubscribe, getDetectedTimeZone, () => null);
}
