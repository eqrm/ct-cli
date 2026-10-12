import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Suites stub `fetch` and run real timers; request spacing would only slow them down.
    // The pacer itself is covered in tests/http.test.ts with an injected clock.
    env: { CT_MAX_REQUESTS_PER_SECOND: "0" },
  },
});
