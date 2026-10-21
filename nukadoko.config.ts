import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "nukadoko";
import { packCheckout } from "./features/steps/lib/workspace.ts";

// Every config key nukadoko reads, one line each: docs/spec.md, "Environments and secrets"
export default defineConfig({
  fixtures: {
    // npm pack builds dist/ through prepack, which took most of every
    // scenario's time when each one packed again. The checkout does not
    // change during a run, so one tarball serves every scenario; each one
    // still installs it into a project of its own.
    packedSolarsql: [
      async ({}, use) => {
        const dir = mkdtempSync(join(tmpdir(), "solarsql-scenario-pack-"));
        await use(await packCheckout(dir));
        rmSync(dir, { recursive: true, force: true });
      },
      { scope: "process" },
    ],
  },
});

declare module "nukadoko" {
  interface StepFixtures {
    /** The tarball `npm pack` wrote from this checkout. */
    packedSolarsql: string;
  }
}
