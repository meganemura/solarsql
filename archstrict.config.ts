import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test, example, spike).
  //   Remove one of these entries if that directory holds module content.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "example/**",
    "spike/**",
  ],
  // init declared one module per directory that holds TypeScript source and
  // one per TypeScript source file, so every file that check analyzes
  // belongs to exactly one module. Merge, rename, or remove entries freely:
  // init never rewrites this file. After an edit, run archstrict init to
  // regenerate archstrict.types.ts.
  //
  // The package exports are one module per file. build and runtime are
  // directories with no barrel, so a file inside them is private. Imports
  // that already reach those files, and the cycle between build and
  // node.ts, are frozen in archstrict.todo.json.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "build", glob: "src/build/**" },
    { name: "d1.ts", glob: "src/d1.ts", surface: "d1.ts" },
    { name: "durable.ts", glob: "src/durable.ts", surface: "durable.ts" },
    { name: "index.ts", glob: "src/index.ts", surface: "index.ts" },
    { name: "node.ts", glob: "src/node.ts", surface: "node.ts" },
    { name: "runtime", glob: "src/runtime/**" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "vitest.config.ts", glob: "vitest.config.ts", surface: "vitest.config.ts" },
    { name: "vitest.mutation.config.ts", glob: "vitest.mutation.config.ts", surface: "vitest.mutation.config.ts" },
  ],
  because: "package exports are single-file modules (index.ts, d1.ts, durable.ts, node.ts); build and runtime are private directory modules, and the crossings that already exist stay frozen debt",
} satisfies Config;
