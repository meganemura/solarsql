#!/usr/bin/env node
// Responsibility: run cascade-check.ts's runCascadeCheck in its own fresh
// process, so it never shares Node's ES module cache with the process that
// built the starter (scale-project.ts's buildScaleStarter imports the same
// starter's module.ts and solarsql.generated.ts in-process while
// establishing the baseline; a later in-process re-import of the same path,
// after the scenario's fix rewrote those files, returns the cached,
// pre-fix module objects instead -- confirmed against this project's own
// generated types, which fell back to "no parameters declared" for an
// unmodified command). A separate process has no such cache to collide
// with, at the cost of one process spawn per check.
// Usage: node cascade-check-worker.ts <dir> <project> <owned|flat>
// Boundary: this file only prints the result as JSON; scale-project.ts
// decides what to do with it.
import { runCascadeCheck, type Arm } from "./cascade-check.ts";

const [dir, project, arm] = process.argv.slice(2);
if (!dir || !project || (arm !== "owned" && arm !== "flat")) {
  console.log(JSON.stringify({ ok: false, reason: `usage: node cascade-check-worker.ts <dir> <project> <owned|flat>, got ${JSON.stringify(process.argv.slice(2))}` }));
  process.exit(1);
}

const result = await runCascadeCheck(dir, project, arm as Arm);
console.log(JSON.stringify(result));
