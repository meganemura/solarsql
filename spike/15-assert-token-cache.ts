// Responsibility: measure whether workerd's per-text compiled-statement
// cache (cloudflare/workerd src/workerd/api/sql.c++, SqlStorage::exec, an
// LRU capped at 1 MiB of SQL text) grows RSS without bound across many
// runs of the same assert, before and after ADR 0086's amendment (the
// invocation token binds as a value instead of sitting in the text).
// Boundary: this experiment prints evidence; it does not change durable.ts
// or plan.ts. spike/15-assert-token-cache-worker.ts is the Durable Object
// this drives; it composes the two SQL shapes directly, not through the
// adapter, so a future adapter change cannot silently change what this
// measures.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { workerMiniflare } from "../test/worker.ts";

const root = resolve(import.meta.dirname, "..");

// workerd runs as Miniflare's own direct child process (measured on
// macOS: its ppid equals this driver's pid; not measured on Linux). The
// first `workerd` row under this pid is the one this run started. No TCC
// prompt: `ps` reads process-table metadata, not another application's
// data.
function workerdPid(): string | null {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  const mine = String(process.pid);
  const line = ps.split("\n").find((l) => {
    const [, ppid, ...rest] = l.trim().split(/\s+/);
    return ppid === mine && /workerd/i.test(rest.join(" "));
  });
  return line ? line.trim().split(/\s+/)[0]! : null;
}

function rssKb(pid: string): number {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim());
}

async function measure(mode: "before" | "after"): Promise<{ runs: number; rssKb: number }[]> {
  const mf = workerMiniflare(resolve(root, "spike/15-assert-token-cache-worker.ts"), root, { durableObjects: { CACHE: "AssertCache" } });
  const samples: { runs: number; rssKb: number }[] = [];
  try {
    // One run to let workerd start, so the pid the first sample reads is
    // the same process every later sample reads.
    await mf.dispatchFetch(`http://localhost/?mode=${mode}&runs=1`);
    const pid = workerdPid();
    if (!pid) throw new Error("workerd process not found as this driver's child");
    let total = 1;
    samples.push({ runs: total, rssKb: rssKb(pid) });
    for (let batch = 0; batch < 10; batch++) {
      await mf.dispatchFetch(`http://localhost/?mode=${mode}&runs=1000`);
      total += 1000;
      samples.push({ runs: total, rssKb: rssKb(pid) });
    }
  } finally {
    await mf.dispose();
  }
  return samples;
}

const before = await measure("before");
const after = await measure("after");
console.log("mode    runs     rss (KB)");
for (const s of before) console.log(`before  ${String(s.runs).padStart(6)}   ${s.rssKb}`);
for (const s of after) console.log(`after   ${String(s.runs).padStart(6)}   ${s.rssKb}`);
const growth = (samples: { runs: number; rssKb: number }[]): number => samples[samples.length - 1]!.rssKb - samples[1]!.rssKb;
console.log(`before: RSS grew ${growth(before)} KB from run 1,000 to run ${before[before.length - 1]!.runs}`);
console.log(`after:  RSS grew ${growth(after)} KB from run 1,000 to run ${after[after.length - 1]!.runs}`);
