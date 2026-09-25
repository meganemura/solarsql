// Spawned by build.test.ts. Patches node:fs's mutable CommonJS module
// object (not the frozen ESM namespace) so writeNewMigration's own
// linkSync call goes through this stub instead of the real one. The stub
// reports readiness and then blocks, so the parent process controls
// exactly when SIGKILL arrives -- after the temporary file's write has
// already returned, before the link into the final name ever happens.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const nodeFs: typeof import("node:fs") = require("node:fs");
nodeFs.linkSync = () => {
  console.log("about to link");
  // Block the call stack itself, not just the event loop: a timer (like
  // setInterval) returns immediately, letting writeNewMigration's finally
  // block delete the temporary file before the parent's kill can land.
  // The wait has a limit, and the process exits when it runs out: if the
  // parent test process dies first (a test runner that bails or times
  // out), no kill arrives, and an unbounded wait would leave this process
  // blocked forever.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.exit(1);
};
const { writeNewMigration } = await import("../../src/build/migration-files.ts");
const [, , dir, filename, sql] = process.argv;
writeNewMigration(dir!, { filename: filename!, sql: sql! });
