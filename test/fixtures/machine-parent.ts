// Responsibility: supply process exits, control messages, and temporary files.
// Boundary: the parent under test owns deadlines and report validation.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const options = JSON.parse(process.argv[3]!) as {
  mode: string; path?: string; receipt?: string; delay?: number; code?: number;
  field?: string; value?: unknown;
  count?: number; ok?: boolean; signal?: boolean; waitBefore?: boolean;
};
const pause = async (ms: number) => {
  // The parent can advance its test clock after control messages and file writes.
  await new Promise<void>(resolve => {
    const released = (message: unknown) => {
      if (message !== "fixture-release") return;
      process.off("message", released);
      resolve();
    };
    process.on("message", released);
    process.send!("fixture-ready");
  });
  await new Promise(resolve => setTimeout(resolve, ms));
};
const protocol = "solarsql.direct-worker.v1";
const token = process.env.SOLARSQL_CLI_PROTOCOL_TOKEN;
const reportToken = process.env.SOLARSQL_REPORT_PROTOCOL_TOKEN;
// Capture the token before machine.ts consumes the worker environment.
const { announceMigrationLock, announceWorkerDone, announceWorkerStarted, printReport } = await import("../../src/build/machine.ts");
// A real worker announces its start before the command runs; the parent's
// deadline starts there.
if (options.mode !== "silent-start" && options.mode !== "late-start") await announceWorkerStarted();

if (options.mode === "report-case") {
  const report = { version: 1, ok: options.ok ?? true, diagnostics: [] };
  const message = { protocol, token: reportToken, type: "report", report };
  const send = (value: unknown) => new Promise<void>((resolve, reject) => {
    process.send!(value, error => error ? reject(error) : resolve());
  });
  if (options.waitBefore) await pause(options.delay!);
  if (options.field) await send(options.field === "null" ? null : { ...message, [options.field]: options.value });
  for (let i = 0; i < (options.count ?? 1); i++) await send(message);
  if (options.delay !== undefined && !options.waitBefore) await pause(options.delay);
  if (options.signal) process.kill(process.pid, "SIGKILL");
  process.exitCode = options.code ?? (report.ok ? 0 : 1);
} else if (options.mode === "report" || options.mode === "remove-root") {
  const root = process.env.TMPDIR!;
  // Reject a shared temporary directory before creating or removing fixture files.
  if (dirname(root) !== dirname(dirname(options.receipt!))) throw new Error("Expected a dedicated temporary directory.");
  writeFileSync(options.receipt!, JSON.stringify([root, process.env.TMP, process.env.TEMP]));
  if (options.mode === "remove-root") rmSync(root, { recursive: true, force: true });
  else {
    mkdirSync(join(root, "snapshot"));
    writeFileSync(join(root, "snapshot", "database.sqlite"), "snapshot");
  }
  await printReport({ version: 1, ok: true, diagnostics: [] });
} else if (options.mode === "function-report") {
  await printReport(Object.assign(() => undefined, { version: 1, ok: true, diagnostics: [] }));
} else if (options.mode === "failure") {
  process.exitCode = 7;
} else if (options.mode === "signal") {
  process.kill(process.pid, "SIGKILL");
} else if (options.mode === "signal-number") {
  process.kill(process.pid, options.code!);
} else if (options.mode === "late-start") {
  // The parent's clock moves while this child is ready but not yet started.
  await pause(0);
  await announceWorkerStarted();
  await announceWorkerDone(0);
  process.exitCode = 0;
} else if (options.mode === "rewritten-exit") {
  await announceWorkerDone(1);
  process.on("exit", () => { process.exitCode = 0; });
  process.exitCode = 1;
} else if (options.mode === "lock") {
  await announceMigrationLock(options.path!);
  writeFileSync(options.receipt!, "acknowledged");
  await pause(options.delay!);
} else if (options.mode === "done") {
  await announceWorkerDone(options.code!);
  await pause(options.delay!);
  process.exitCode = options.code;
} else if (options.mode === "raw-lock") {
  // IPC keeps message order, so the parent's acknowledgements arrive before
  // its reply to the ping below; the receipt is complete before the deadline
  // can kill this child.
  const synced = new Promise<void>(resolve => {
    process.on("message", value => {
      if (value === "fixture-pong") resolve();
      else if (value !== "fixture-release") appendFileSync(options.receipt!, JSON.stringify(value) + "\n");
    });
  });
  const message = { protocol, token, type: "migration-lock", nonce: "accepted", path: options.path };
  const invalid = [null, {}, ...["protocol", "token", "type"].map(field => ({ ...message, [field]: "wrong", nonce: field })),
    { ...message, nonce: 42 }, { ...message, nonce: "path", path: 42 }];
  for (const value of [...invalid, message, { ...message, nonce: "second" }]) process.send!(value);
  process.send!("fixture-ping");
  await synced;
  await pause(options.delay!);
} else if (options.mode === "raw-done") {
  process.send!({ protocol, token, type: "worker-done", code: 7, [options.field!]: options.value });
  await pause(options.delay!);
  process.exitCode = 7;
} else {
  await pause(options.delay!);
  process.exitCode = options.code ?? 0;
}
process.exit(process.exitCode ?? 0);
