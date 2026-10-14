import { defineConfig, defineFixtures } from "nukadoko";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch directories a step can write into freely, removed after the
// scenario whether it passed or failed.
export interface Scratch {
  dir(prefix: string): string;
}

const fixtures = defineFixtures({
  scratch: async ({}, use) => {
    const dirs: string[] = [];
    await use({
      dir(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
        dirs.push(dir);
        return dir;
      },
    });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  },
});

declare module "nukadoko" {
  interface StepFixtures {
    scratch: Scratch;
  }
}

export default defineConfig({
  // Every config key nukadoko reads, one line each: docs/spec.md, "Sessions, environments, secrets"
  fixtures,
});
