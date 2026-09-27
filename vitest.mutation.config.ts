// Responsibility: the test set that `npm run test:mutation` runs under
// StrykerJS.
// Boundary: this file selects tests only; stryker.config.json holds the
// mutation settings.
//
// Why only the in-process set: a test in test/slow or test/miniflare runs
// the code in a child process or in workerd, where Stryker cannot see which
// mutant the code reached.
// Why test/slow/rehearse-file.test.ts is the one exception: it runs
// rehearse() in the same process; its own slowness comes from an on-disk
// backup, not a child process or workerd, so Stryker can see which mutant
// it reached.
// Why stale.test.ts is left out: it checks the result of tsc. Stryker's
// instrumented src carries @ts-nocheck and code that changes the inferred
// types, so the test fails with no mutant active. Plain `npm test` runs it.
// Why Node's own import instead of Vite's module runner: vitest.config.ts
// gives the reasons.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.test.ts", "test/slow/rehearse-file.test.ts"],
    exclude: [...configDefaults.exclude, "test/stale.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    experimental: { viteModuleRunner: false },
  },
});
