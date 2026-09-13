// Responsibility: separate machine reports and enforce CLI process budgets.
// Boundary: application permissions stay unchanged; native work runs in the worker.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const marker = "SOLARSQL_REPORT_CHANNEL";
const worker = process.env[marker] === "ipc" && typeof process.send === "function";
const humanMarker = "SOLARSQL_CLI_WORKER";
const protocolMarker = "SOLARSQL_CLI_PROTOCOL_TOKEN";
const protocol = "solarsql.direct-worker.v1";
const humanWorker = process.env[humanMarker] === "ipc" && typeof process.send === "function";
const protocolToken = humanWorker ? process.env[protocolMarker] : undefined;
const directSend = humanWorker ? process.send!.bind(process) : undefined;
const directOn = humanWorker ? process.on.bind(process) : undefined;
const directOff = humanWorker ? process.off.bind(process) : undefined;
const send = worker ? process.send!.bind(process) : undefined;
// Imported programs can start another CLI; it must create its own report channel.
if (worker) delete process.env[marker];
if (humanWorker) delete process.env[humanMarker];
if (humanWorker) delete process.env[protocolMarker];

export function isReportWorker(): boolean { return worker; }
export function isCliWorker(): boolean { return humanWorker; }

// The token is removed before project imports. This separates worker control
// messages from application IPC without relying on a mutable process.send.
export async function announceMigrationLock(path: string): Promise<void> {
  if (!directSend || !directOn || !directOff || !protocolToken) return;
  const nonce = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const received = (message: unknown) => {
      const value = message as { protocol?: unknown; token?: unknown; type?: unknown; nonce?: unknown };
      if (value?.protocol !== protocol || value.token !== protocolToken || value.type !== "migration-lock-ack" || value.nonce !== nonce) return;
      directOff("message", received);
      resolve();
    };
    directOn("message", received);
    directSend({ protocol, token: protocolToken, type: "migration-lock", nonce, path }, error => {
      if (!error) return;
      directOff("message", received);
      reject(error);
    });
  });
}

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

// Keep the human CLI streams and status contract, while the parent owns the
// only process it can safely stop. Application-owned descendants are outside
// this boundary.
export async function runHuman(cli: string, args: string[], timeoutMs: number): Promise<number> {
  const protocolToken = randomUUID();
  const child = fork(cli, args, {
    env: { ...process.env, [humanMarker]: "ipc", [protocolMarker]: protocolToken },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  let failure: Error | undefined;
  let timedOut = false;
  let migrationLock: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.on("error", error => { failure = error; });
  const announceLock = (message: unknown) => {
    const value = message as { protocol?: unknown; token?: unknown; type?: unknown; nonce?: unknown; path?: unknown };
    if (value?.protocol !== protocol || value.token !== protocolToken || value.type !== "migration-lock" || typeof value.nonce !== "string" || typeof value.path !== "string") return;
    migrationLock = value.path;
    child.off("message", announceLock);
    child.send({ protocol, token: protocolToken, type: "migration-lock-ack", nonce: value.nonce });
  };
  child.on("message", announceLock);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  clearTimeout(timer);
  if (timedOut) {
    const lock = args[0] === "migration" && migrationLock && existsSync(migrationLock)
      ? ` The migration lock remains at ${migrationLock}. Inspect it and remove it only after this worker has stopped.`
      : "";
    console.error(`error: The operation exceeded its ${timeoutMs}ms time budget. Inspect the configuration import and generated output before you set --timeout-ms to a larger positive budget.${lock}`);
    return 1;
  }
  if (failure) {
    console.error(`error: ${failure.message}`);
    return 1;
  }
  return signal === null && code !== null ? code : 1;
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
