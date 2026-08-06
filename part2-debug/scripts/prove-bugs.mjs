#!/usr/bin/env node
/**
 * Proves two claims from the Part 2 write-up instead of asking you to take them
 * on trust:
 *
 *   1. `original.ts` does NOT type-check. The missing `await` is a hard `tsc`
 *      error, not a subtle runtime-only bug — which means the original was
 *      committed without a typecheck in CI. That is the actual root cause worth
 *      fixing: one bug was a mistake, shipping it was a process gap.
 *
 *   2. `fixed.ts` DOES type-check, under `strict` plus
 *      `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
 *
 * Exits non-zero if either claim fails.
 */
import { spawnSync } from "node:child_process";

const tsc = (project) =>
  spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsc", "--noEmit", "-p", project],
    { encoding: "utf8" },
  );

let failures = 0;

console.log("→ Claim 1: original.ts must FAIL to type-check\n");
const original = tsc("tsconfig.original.json");
const originalOutput = `${original.stdout ?? ""}${original.stderr ?? ""}`.trim();

if (original.status === 0) {
  console.error("  ✗ original.ts compiled cleanly — expected a type error.\n");
  failures += 1;
} else {
  console.log("  ✓ tsc rejected it, as expected:\n");
  console.log(
    originalOutput
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
  );
  console.log(
    "\n    ^ The TS2339 on line 35 is BUG 1: `.get()` returns a Promise, so\n" +
      "      `.docs` is not a property that exists. A typecheck in CI would\n" +
      "      have blocked this PR before it ever reached production.\n" +
      "\n" +
      "      The TS2345 on line 22 is a bonus find: on firebase-functions v6\n" +
      "      the bare `from \"firebase-functions\"` import now resolves to the\n" +
      "      *v2* API, whose handler takes a single `CallableRequest` rather\n" +
      "      than `(data, context)`. The original's signature is written\n" +
      "      against v1. `fixed.ts` imports from `firebase-functions/v1`\n" +
      "      explicitly so the intended API is pinned.\n",
  );
}

console.log("→ Claim 2: fixed.ts must type-check cleanly\n");
const fixed = tsc("tsconfig.json");
const fixedOutput = `${fixed.stdout ?? ""}${fixed.stderr ?? ""}`.trim();

if (fixed.status === 0) {
  console.log("  ✓ fixed.ts compiles under strict mode.\n");
} else {
  console.error("  ✗ fixed.ts failed to compile:\n");
  console.error(fixedOutput);
  failures += 1;
}

if (failures > 0) {
  console.error(`${failures} claim(s) failed.`);
  process.exit(1);
}
console.log("Both claims hold.");
