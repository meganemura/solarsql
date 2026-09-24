import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  surface: "index.ts",
  exclude: [
    "*.ts",
    "test/**",
    "example/**",
    "spike/**",
    "dist/**",
    "coverage/**",
    "scripts/**",
    "features/**",
  ],
  classify: [{ glob: "src/**", tags: ["kind:lib"] }],
  // First operational adopt: one module for the whole library surface.
  // Refine into build/runtime boundaries later once single-file modules are safe.
  declaredModules: [
    { name: "solarsql", glob: "src/**", surface: "index.ts" },
  ],
  because: "solarsql first adopt: single src module; exclude test/example/spike",
} satisfies Config;
