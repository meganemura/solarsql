import type { Config } from "./archstrict.types.js";

// Seams follow where the code grows, not the two directories it sits in.
// src/build is one flat folder of explicit .ts imports, and a module glob
// cannot brace several names, so each seam is one file. A directory move
// would rewrite every import to buy privacy that a surface (everyone) or a
// friend (one caller) already gives. A new file under src/build is private
// to the outermost layer until someone classifies it inward; a barrel at
// src/build/index.ts or src/runtime/index.ts would undo that, so both stay
// empty.
//
// Layers, foundation first: kernel, sql, typing, policy, build, command, cli.
// Planes: scan is shared text; src/runtime is the Workers contract; the four
// package exports are adapters; machine.ts is the CLI worker channel; the
// rest of src/build is the compiler. Adapters never import the compiler.
// The one compiler file that opens a database is query.ts, through node.ts.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "example/**",
    "spike/**",
    // Runner config, not a product module. Leaving it declared pulled it
    // into the layer order with zero imports.
    "vitest.config.ts",
    "vitest.mutation.config.ts",
  ],
  declaredModules: [
    // Shared SQL text. Durable Objects and node.ts import this; it imports nothing.
    { name: "scan", glob: "src/build/scan.ts", surface: "scan.ts" },
    { name: "shell", glob: "src/build/shell.ts", surface: "shell.ts" },
    // The typer's error, split out so the schema diff does not depend on typegen.ts.
    { name: "build-error", glob: "src/build/build-error.ts", surface: "build-error.ts" },
    { name: "lock-timeout", glob: "src/build/lock-timeout.ts", surface: "lock-timeout.ts" },
    { name: "machine", glob: "src/build/machine.ts", surface: "machine.ts" },
    // scope.ts is the typer's private walk. One caller.
    {
      name: "scope",
      glob: "src/build/scope.ts",
      surface: [],
      friends: [{ file: "scope.ts", from: "src/build/typegen.ts", because: "scope.ts walks a select for the typer and has no other caller" }],
    },
    { name: "facts", glob: "src/build/facts.ts", surface: "facts.ts" },
    { name: "typegen", glob: "src/build/typegen.ts", surface: "typegen.ts" },
    { name: "emit", glob: "src/build/emit.ts", surface: "emit.ts" },
    { name: "statements", glob: "src/build/statements.ts", surface: "statements.ts" },
    { name: "output", glob: "src/build/output.ts", surface: "output.ts" },
    // Schema diff. migration-files.ts writes history; only build.ts calls it.
    { name: "migrate", glob: "src/build/migration.ts", surface: "migration.ts" },
    { name: "migration-intent", glob: "src/build/migration-intent.ts", surface: "migration-intent.ts" },
    {
      name: "migration-files",
      glob: "src/build/migration-files.ts",
      surface: [],
      friends: [{ file: "migration-files.ts", from: "src/build/build.ts", because: "build.ts is the only writer of migration files; the CLI asks build.ts for a migration" }],
    },
    { name: "build", glob: "src/build/build.ts", surface: "build.ts" },
    { name: "analyze", glob: "src/build/analyze.ts", surface: "analyze.ts" },
    { name: "rehearse", glob: "src/build/rehearse.ts", surface: "rehearse.ts" },
    { name: "init", glob: "src/build/init.ts", surface: "init.ts" },
    { name: "query", glob: "src/build/query.ts", surface: "query.ts" },
    // cli.ts exits the process on import. Nothing may import it.
    { name: "cli", glob: "src/build/cli.ts", surface: [] },
    { name: "plan", glob: "src/runtime/plan.ts", surface: "plan.ts" },
    {
      name: "failure",
      glob: "src/runtime/failure.ts",
      surface: [],
      friends: [{ file: "failure.ts", from: "src/index.ts", because: "failureClass is part of the public API, re-exported from index.ts; adapters do not import this file" }],
    },
    { name: "id", glob: "src/runtime/id.ts", surface: "id.ts" },
    { name: "node-version", glob: "src/runtime/node-version.ts", surface: "node-version.ts" },
    { name: "node-limits", glob: "src/runtime/node-limits.ts", surface: "node-limits.ts" },
    { name: "index", glob: "src/index.ts", surface: "index.ts" },
    { name: "d1", glob: "src/d1.ts", surface: "d1.ts" },
    { name: "durable", glob: "src/durable.ts", surface: "durable.ts" },
    { name: "node", glob: "src/node.ts", surface: "node.ts" },
  ],
  // A new src/build file matches only the directory catch-all: compiler,
  // outermost layer, no filesystem, no child_process. Move it inward by
  // naming the file. src/runtime/** stays the Workers contract.
  classify: [
    { glob: "src/build/**", tags: ["plane:compiler", "layer:cli", "io:pure", "proc:rest"] },
    { glob: "src/runtime/**", tags: ["plane:engine", "io:pure", "proc:rest"] },
    { glob: "src/index.ts", tags: ["plane:adapter", "io:pure", "proc:rest"] },
    { glob: "src/d1.ts", tags: ["plane:adapter", "io:pure", "proc:rest"] },
    { glob: "src/durable.ts", tags: ["plane:adapter", "io:pure", "proc:rest"] },
    { glob: "src/node.ts", tags: ["plane:adapter", "io:pure", "proc:rest"] },
    { glob: "src/build/scan.ts", tags: ["plane:text", "layer:kernel", "io:pure", "proc:rest"] },
    { glob: "src/build/shell.ts", tags: ["plane:compiler", "layer:kernel", "io:pure", "proc:rest"] },
    { glob: "src/build/build-error.ts", tags: ["plane:compiler", "layer:kernel", "io:pure", "proc:rest"] },
    { glob: "src/build/lock-timeout.ts", tags: ["plane:compiler", "layer:kernel", "io:pure", "proc:rest"] },
    { glob: "src/build/machine.ts", tags: ["plane:process", "layer:kernel", "proc:worker"] },
    { glob: "src/build/scope.ts", tags: ["plane:compiler", "layer:sql", "io:pure", "proc:rest"] },
    { glob: "src/build/facts.ts", tags: ["plane:compiler", "layer:sql", "io:pure", "proc:rest"] },
    { glob: "src/build/typegen.ts", tags: ["plane:compiler", "layer:typing", "io:pure", "proc:rest"] },
    { glob: "src/build/emit.ts", tags: ["plane:compiler", "layer:typing", "io:pure", "proc:rest"] },
    { glob: "src/build/statements.ts", tags: ["plane:compiler", "layer:policy", "io:pure", "proc:rest"] },
    { glob: "src/build/output.ts", tags: ["plane:compiler", "layer:policy", "proc:rest"] },
    { glob: "src/build/migration.ts", tags: ["plane:compiler", "layer:policy", "io:pure", "proc:rest"] },
    { glob: "src/build/migration-intent.ts", tags: ["plane:compiler", "layer:policy", "proc:rest"] },
    { glob: "src/build/migration-files.ts", tags: ["plane:compiler", "layer:policy", "proc:rest"] },
    { glob: "src/build/build.ts", tags: ["plane:compiler", "layer:build", "proc:rest"] },
    { glob: "src/build/analyze.ts", tags: ["plane:compiler", "layer:command", "proc:rest"] },
    { glob: "src/build/rehearse.ts", tags: ["plane:compiler", "layer:command", "proc:rest"] },
    { glob: "src/build/init.ts", tags: ["plane:compiler", "layer:command", "proc:rest"] },
    { glob: "src/build/query.ts", tags: ["plane:compiler", "layer:command", "proc:rest"] },
    { glob: "src/build/cli.ts", tags: ["plane:compiler", "layer:cli", "proc:rest"] },
  ],
  edges: {
    allowDeny: [
      {
        source: "plane:adapter",
        targetNamespace: "plane",
        allow: ["engine", "text"],
        edgeType: "value",
        because: "D1, a Durable Object, and the node shim execute plans through scan and the runtime contract; they do not import the compiler or the CLI worker channel",
      },
      {
        source: "plane:compiler",
        targetNamespace: "plane",
        allow: ["text", "engine", "process"],
        edgeType: "value",
        exceptions: [
          {
            from: "src/build/query.ts",
            to: "src/node.ts",
            because: "solarsql query is the one compiler command that opens a database, and it does that through the node adapter",
          },
        ],
        because: "the compiler may use scan, the runtime contract, and the CLI worker channel; opening a database stays in query.ts",
      },
      {
        source: "proc:rest",
        targetNamespace: "pkg",
        deny: ["child_process"],
        edgeType: "value",
        because: "child_process belongs to the CLI worker channel in machine.ts; every other module stays in-process",
      },
    ],
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["kernel", "sql", "typing", "policy", "build", "command", "cli"] },
        direction: "downward-only",
        edgeType: "value",
        because: "value imports already run from the CLI down through commands, build.ts, the schema diff, typing, and engine facts to the text kernel; a lower layer must not grow a dependency on a higher one",
      },
    ],
    point: [
      {
        from: "src/runtime/**",
        to: "src/build/**",
        edgeType: "value",
        because: "the runtime contract runs in Workers and must not import the compiler",
      },
      {
        from: "src/runtime/**",
        to: "src/index.ts",
        edgeType: "value",
        because: "plan.ts may name index.ts types, but a value import would cycle through failure.ts, which index.ts already imports",
      },
      {
        from: "src/runtime/**",
        to: "src/d1.ts",
        edgeType: "value",
        because: "the runtime contract must not import an adapter",
      },
      {
        from: "src/runtime/**",
        to: "src/durable.ts",
        edgeType: "value",
        because: "the runtime contract must not import an adapter",
      },
      {
        from: "src/runtime/**",
        to: "src/node.ts",
        edgeType: "value",
        because: "the runtime contract must not import an adapter",
      },
      // Point rules, not an allowDeny deny of every Node builtin. facts.ts
      // and migration.ts import node:sqlite, and a Node that does not list
      // that module as a builtin records no package edge for it, which makes
      // an allowDeny sourced at io:pure match nothing. These rules match the
      // value edges those files already have, and they name the builtins
      // the schema diff must not grow. child_process is proc:rest's deny.
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:fs"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import the filesystem; facts.ts and migration.ts keep node:sqlite",
      },
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:path"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import the filesystem; facts.ts and migration.ts keep node:sqlite",
      },
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:crypto"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import node:crypto; id.ts uses globalThis.crypto",
      },
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:os"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import node:os",
      },
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:diagnostics_channel"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import node:diagnostics_channel",
      },
      {
        from: { tags: ["io:pure"] },
        to: { tags: ["pkg:url"] },
        edgeType: "value",
        because: "Workers-shipped code, scan, the typer, and the schema diff do not import node:url",
      },
    ],
  },
  // Every module is clean: the old build/runtime bypasses were the missing
  // surfaces, and the query.ts → node.ts cycle was those two files sharing
  // one module. A new crossing fails check; it is not a todo entry.
  strict: [
    "analyze",
    "build",
    "build-error",
    "cli",
    "d1",
    "durable",
    "emit",
    "facts",
    "failure",
    "id",
    "index",
    "init",
    "lock-timeout",
    "machine",
    "migrate",
    "migration-files",
    "migration-intent",
    "node",
    "node-limits",
    "node-version",
    "output",
    "plan",
    "query",
    "rehearse",
    "scan",
    "scope",
    "shell",
    "statements",
    "typegen",
  ],
  mustBeEmpty: [
    {
      glob: "src/build/index.ts",
      because: "a barrel would let one import reach scan, the schema diff, the compiler, and the CLI; each seam stays a file",
    },
    {
      glob: "src/runtime/index.ts",
      because: "a barrel would hide which runtime contract a caller uses; index.ts re-exports the public API, and adapters name plan.ts directly",
    },
  ],
  because: "scan, the schema diff, the compiler, the CLI, and the Workers adapters change for different reasons, so each is its own module instead of one build directory and one runtime directory",
} satisfies Config;
