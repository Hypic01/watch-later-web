import { defineConfig } from "vitest/config";

// PGlite boots a real Postgres (compiled to WASM) per DB-backed test file. Under
// parallel load that occasionally blows past vitest's 5s default and fails a run
// that is actually fine. A flaky suite is worse than a slow one: it trains you to
// ignore red. Give the DB room.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
