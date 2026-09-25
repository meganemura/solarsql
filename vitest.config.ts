// Responsibility: the three test sets and their shared limits.
// Boundary: no test logic; each test file owns its fixtures and cleanup.
//
// Why three projects: `npm test` runs only the in-process set (node:sqlite),
// and `npm run test:all` adds the child-process and workerd sets, the split
// the scripts drew before the move to Vitest.
// Why the long timeouts: node:test has no default timeout, and several
// tests (a build of the example, a workerd start, a packed install) run
// far past Vitest's 5-second default by design.
// Why Node's own import instead of Vite's module runner: the tests and the
// build run as plain Node with type stripping, and the build depends on
// Node's module semantics. Under the module runner, a module namespace
// lists exports in declared order instead of sorted order, a missing
// import's error has no `url`, and a module that failed to load stays
// failed after the build writes the file it lacked.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    experimental: { viteModuleRunner: false },
    projects: [
      { extends: true, test: { name: "unit", include: ["test/*.test.ts"] } },
      { extends: true, test: { name: "slow", include: ["test/slow/*.test.ts"] } },
      { extends: true, test: { name: "miniflare", include: ["test/miniflare/*.test.ts"] } },
    ],
  },
});
