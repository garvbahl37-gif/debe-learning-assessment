import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Pin the process timezone.
    //
    // Not to make the tests pass — nothing under test reads the ambient zone,
    // which is the property being defended. It is pinned so that if someone
    // later slips a bare `new Date("2026-08-08T15:00")` into the shared code,
    // these tests fail on CI (UTC) rather than passing on whichever laptop
    // happens to run them. A deliberately awkward half-hour offset makes that
    // failure loud.
    env: { TZ: "Asia/Kolkata" },
  },
});
