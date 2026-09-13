// Responsibility: separate machine reports from application import output.
// Boundary: this controls transport, not application permissions or side effects.
import { fork } from "node:child_process";

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

export async function runMachine(cli: string, args: string[]): Promise<number> {
  const child = fork(cli, args, {
    env: { ...process.env, [marker]: "ipc" },
    // Both application streams retain their output on the diagnostic stream.
    stdio: ["inherit", 2, 2, "ipc"],
  });
  const reports: unknown[] = [];
  let failure: Error | undefined;
  child.on("message", message => reports.push((message as { report?: unknown })?.report));
  child.on("error", error => { failure = error; });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  const report = reports[0];
  if (!failure && reports.length === 1 && validReport(report) && code === (report.ok ? 0 : 1) && signal === null) {
    await printReport(report);
    return code;
  }
  await printReport({ version: 1, ok: false, diagnostics: [{ code: "BUILD_WORKER_FAILED",
    message: failure?.message ?? `The build process ended without one valid report (exit ${code}, signal ${signal}).`,
    action: "Check stderr for application import output and premature process termination." }] });
  return 1;
}
