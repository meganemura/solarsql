// Responsibility: separate machine reports and enforce CLI process budgets.
// Boundary: application permissions stay unchanged; native work runs in the worker.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const marker = "SOLARSQL_REPORT_CHANNEL";
const worker = process.env[marker] === "ipc" && typeof process.send === "function";
const send = worker ? process.send!.bind(process) : undefined;
// Imported programs can start another CLI; it must create its own report channel.
if (worker) delete process.env[marker];

export function isReportWorker(): boolean { return worker; }

export async function printReport(report: unknown): Promise<void> {
  if (send) {
    await new Promise<void>((resolve, reject) => send({ report }, error => error ? reject(error) : resolve()));
  } else {
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(report) + "\n", error => error ? reject(error) : resolve()));
  }
}

function validReport(value: unknown): value is { version: 1; ok: boolean; diagnostics: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 && typeof report.ok === "boolean" && Array.isArray(report.diagnostics);
}

type ProcessOptions = { timeoutMs?: number; temporaryRoot?: string; failureCode?: string; timeoutCode?: string; action?: string };

export async function runRehearsalProcess(cli: string, args: string[], timeoutMs: number): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "solarsql-rehearse-run-"));
  let result;
  try {
    result = await collectReport(cli, args, { timeoutMs, temporaryRoot: root,
      failureCode: "REHEARSAL_WORKER_FAILED", timeoutCode: "REHEARSAL_TIMEOUT",
      action: "Inspect the proposed SQL and source workload. Set --timeout-ms to a larger positive budget if the work requires more time." });
  } finally {
    // The worker can die inside native SQLite. Its parent owns every snapshot.
    rmSync(root, { recursive: true, force: true });
  }
  await printReport(result.report);
  return result.code;
}

export async function runMachine(cli: string, args: string[], options: ProcessOptions = {}): Promise<number> {
  const result = await collectReport(cli, args, options);
  await printReport(result.report);
  return result.code;
}

async function collectReport(cli: string, args: string[], options: ProcessOptions): Promise<{ code: number; report: unknown }> {
  const child = fork(cli, args, {
    env: { ...process.env, [marker]: "ipc", ...(options.temporaryRoot ? {
      TMPDIR: options.temporaryRoot, TMP: options.temporaryRoot, TEMP: options.temporaryRoot,
    } : {}) },
    // Both application streams retain their output on the diagnostic stream.
    stdio: ["inherit", 2, 2, "ipc"],
  });
  const reports: unknown[] = [];
  let failure: Error | undefined;
  let timedOut = false;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    // A blocked native call cannot cooperate with a JavaScript cancellation.
    child.kill("SIGKILL");
  }, options.timeoutMs);
  child.on("message", message => reports.push((message as { report?: unknown })?.report));
  child.on("error", error => { failure = error; });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  clearTimeout(timer);
  const report = reports[0];
  if (!timedOut && !failure && reports.length === 1 && validReport(report) && code === (report.ok ? 0 : 1) && signal === null) {
    return { code, report };
  }
  return { code: 1, report: { version: 1, ok: false, diagnostics: [{ code: timedOut ? options.timeoutCode ?? "WORKER_TIMEOUT" : options.failureCode ?? "BUILD_WORKER_FAILED",
    message: timedOut ? `The operation exceeded its ${options.timeoutMs}ms time budget.` : failure?.message ?? `The process ended without one valid report (exit ${code}, signal ${signal}).`,
    timeoutMs: timedOut ? options.timeoutMs : undefined,
    action: options.action ?? "Check stderr for application import output and premature process termination." }] } };
}
