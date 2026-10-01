// Responsibility: exercise worker messages and report validation in the test process.
// Boundary: child processes supply reports only; CLI execution budgets belong to other tests.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
// Mutation testing selects test files by their static imports; the
// fresh copies below load through import() and do not count. The stub
// loads first because ESM evaluates imports in order.
import "./fixtures/process-send-stub.ts";
import "../src/build/machine.ts";

const markers = ["SOLARSQL_REPORT_CHANNEL", "SOLARSQL_REPORT_PROTOCOL_TOKEN", "SOLARSQL_CLI_WORKER", "SOLARSQL_CLI_PROTOCOL_TOKEN"] as const;
const savedEnv = markers.map(key => process.env[key]);
const savedSend = Object.getOwnPropertyDescriptor(process, "send");
const savedOn = process.on;
const savedOff = process.off;
const savedWrite = process.stdout.write;
let generation = 0;
type Message = Record<string, unknown>;
type Callback = (error: Error | null) => void;

afterEach(() => {
  markers.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  if (savedSend) Object.defineProperty(process, "send", savedSend);
  else delete process.send;
  process.on = savedOn;
  process.off = savedOff;
  process.stdout.write = savedWrite;
  vi.resetModules();
});

async function load(reportMarker = "ipc", cliMarker = "ipc", hasSend = true, token: string | null = "cli-token") {
  process.env.SOLARSQL_REPORT_CHANNEL = reportMarker;
  process.env.SOLARSQL_REPORT_PROTOCOL_TOKEN = "report-token";
  process.env.SOLARSQL_CLI_WORKER = cliMarker;
  if (token === null) delete process.env.SOLARSQL_CLI_PROTOCOL_TOKEN;
  else process.env.SOLARSQL_CLI_PROTOCOL_TOKEN = token;
  const messages: { message: Message; callback: Callback }[] = [];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const removed: string[] = [];
  Object.defineProperty(process, "send", { configurable: true, writable: true, value: hasSend ? function(this: unknown, message: Message, callback: Callback) {
    assert.equal(this, process);
    messages.push({ message, callback });
    return true;
  } : undefined });
  process.on = function(this: unknown, event: string, listener: (value: unknown) => void) {
    assert.equal(this, process);
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return process;
  } as typeof process.on;
  process.off = function(this: unknown, event: string, listener: (value: unknown) => void) {
    assert.equal(this, process);
    removed.push(event);
    listeners.get(event)?.delete(listener);
    return process;
  } as typeof process.off;
  vi.resetModules();
  // Native ESM keeps its own cache when Vitest's module runner is disabled.
  const machine = await import(new URL(`../src/build/machine.ts?worker=${++generation}`, import.meta.url).href) as typeof import("../src/build/machine.ts");
  return { machine, messages, listeners, removed, emit(value: unknown) {
    for (const listener of listeners.get("message") ?? []) listener(value);
  } };
}

async function settled(promise: Promise<void>) {
  const result: { state: string; error?: unknown } = { state: "pending" };
  void promise.then(() => { result.state = "resolved"; }, error => { result.state = "rejected"; result.error = error; });
  await Promise.resolve();
  return result;
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

test("worker detection requires each IPC marker and a send function, and consumes only active markers", async () => {
  for (const report of ["ipc", "other", ""]) for (const cli of ["ipc", "other", ""]) for (const send of [true, false]) {
    const { machine } = await load(report, cli, send);
    assert.equal(machine.isReportWorker(), report === "ipc" && send);
    assert.equal(machine.isCliWorker(), cli === "ipc" && send);
    assert.equal(process.env.SOLARSQL_REPORT_CHANNEL, report === "ipc" && send ? undefined : report);
    assert.equal(process.env.SOLARSQL_REPORT_PROTOCOL_TOKEN, report === "ipc" && send ? undefined : "report-token");
    assert.equal(process.env.SOLARSQL_CLI_WORKER, cli === "ipc" && send ? undefined : cli);
    assert.equal(process.env.SOLARSQL_CLI_PROTOCOL_TOKEN, cli === "ipc" && send ? undefined : "cli-token");
  }
});

test("migration lock sends its path and accepts only the matching acknowledgement", async () => {
  const channel = await load();
  const result = await settled(channel.machine.announceMigrationLock("/tmp/migration.lock"));
  assert.equal(channel.messages.length, 1);
  const { message, callback } = channel.messages[0]!;
  assert.deepEqual(message, { protocol: "solarsql.direct-worker.v1", token: "cli-token", type: "migration-lock", nonce: message.nonce, path: "/tmp/migration.lock" });
  assert.match(message.nonce as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(channel.listeners.get("message")?.size, 1);
  callback(null);
  await flush();
  assert.equal(result.state, "pending");
  assert.deepEqual(channel.removed, []);
  const ack = { protocol: message.protocol, token: message.token, type: "migration-lock-ack", nonce: message.nonce };
  for (const value of [null, undefined, {}, ...Object.keys(ack).map(key => ({ ...ack, [key]: "wrong" }))]) {
    channel.emit(value);
    await flush();
    assert.equal(result.state, "pending");
    assert.equal(channel.listeners.get("message")?.size, 1);
  }
  channel.emit(ack);
  await flush();
  assert.equal(result.state, "resolved");
  assert.deepEqual(channel.removed, ["message"]);
  assert.equal(channel.listeners.get("message")?.size, 0);
});

test("migration lock rejects a send error and removes its listener", async () => {
  const channel = await load();
  const result = await settled(channel.machine.announceMigrationLock("/tmp/failed.lock"));
  const error = new Error("send failed");
  channel.messages[0]!.callback(error);
  await flush();
  assert.equal(result.state, "rejected");
  assert.equal(result.error, error);
  assert.deepEqual(channel.removed, ["message"]);
  assert.equal(channel.listeners.get("message")?.size, 0);
});

test("control announcements return without sending outside a CLI worker or without a token", async () => {
  for (const [marker, send, token] of [["other", true, "token"], ["ipc", false, "token"], ["ipc", true, null], ["ipc", true, ""]] as const) {
    const channel = await load("other", marker, send, token);
    // settled() rather than await: a send that wrongly happens waits on an
    // acknowledgement or a send callback that never comes, and an awaited
    // promise would hang instead of failing.
    assert.equal((await settled(channel.machine.announceMigrationLock("/tmp/unused.lock"))).state, "resolved");
    assert.equal((await settled(channel.machine.announceWorkerDone(7))).state, "resolved");
    assert.deepEqual(channel.messages, []);
    assert.equal(channel.listeners.size, 0);
  }
});

test("worker done sends the exit code and settles from the send callback", async () => {
  const channel = await load();
  for (const error of [null, new Error("done failed")]) {
    const result = await settled(channel.machine.announceWorkerDone(7));
    const entry = channel.messages.at(-1)!;
    assert.deepEqual(entry.message, { protocol: "solarsql.direct-worker.v1", token: "cli-token", type: "worker-done", code: 7 });
    assert.equal(result.state, "pending");
    entry.callback(error);
    await flush();
    assert.equal(result.state, error ? "rejected" : "resolved");
    if (error) assert.equal(result.error, error);
  }
});

test("report worker sends the report with its captured token and propagates send errors", async () => {
  const channel = await load();
  const report = { version: 1, ok: true, diagnostics: [] };
  for (const error of [null, new Error("report failed")]) {
    const result = await settled(channel.machine.printReport(report));
    const entry = channel.messages.at(-1)!;
    assert.deepEqual(entry.message, { protocol: "solarsql.direct-worker.v1", token: "report-token", type: "report", report });
    assert.equal(result.state, "pending");
    entry.callback(error);
    await flush();
    assert.equal(result.state, error ? "rejected" : "resolved");
    if (error) assert.equal(result.error, error);
  }
});

function captureOutput() {
  const writes: { text: string; callback: Callback }[] = [];
  process.stdout.write = ((text: string, callback: Callback) => {
    writes.push({ text, callback });
    return true;
  }) as typeof process.stdout.write;
  return writes;
}

test("nonworker reports serialize as one JSON line and propagate write errors", async () => {
  const { machine, messages } = await load("other", "other");
  const writes = captureOutput();
  await hegel.testAsync(async tc => {
    const report = { text: tc.draw(gs.text({ maxSize: 40 })), count: tc.draw(gs.integers()), ok: tc.draw(gs.booleans()) };
    const result = await settled(machine.printReport(report));
    const write = writes.at(-1)!;
    assert.equal(write.text, JSON.stringify(report) + "\n");
    assert.deepEqual(JSON.parse(write.text), report);
    assert.equal(result.state, "pending");
    write.callback(null);
    await flush();
    assert.equal(result.state, "resolved");
  });
  const error = new Error("write failed");
  const result = await settled(machine.printReport(null));
  writes.at(-1)!.callback(error);
  await flush();
  assert.equal(result.state, "rejected");
  assert.equal(result.error, error);
  assert.deepEqual(messages, []);
});

test("runMachine accepts valid reports and rejects null, primitives, and invalid report fields", async () => {
  const { machine } = await load("other", "other");
  // Checked first: a report worker would send its report through the fake
  // send, whose callback never runs, and runMachine would not return.
  assert.equal(machine.isReportWorker(), false);
  const reports = [{ version: 1, ok: true, diagnostics: [] }, { version: 1, ok: false, diagnostics: [] }, null, 7, "report", false, { version: 2, ok: true, diagnostics: [] }, { version: 1, ok: 1, diagnostics: [] }, { version: 1, ok: true, diagnostics: {} }];
  for (const report of reports) {
    const writes = captureOutput();
    process.stdout.write = ((text: string, callback: Callback) => {
      writes.push({ text, callback });
      callback(null);
      return true;
    }) as typeof process.stdout.write;
    const code = await machine.runMachine(fileURLToPath(new URL("./fixtures/machine-report.ts", import.meta.url)), [JSON.stringify(report)], { timeoutMs: 5000 });
    assert.equal(writes.length, 1);
    const printed = JSON.parse(writes[0]!.text);
    if (report === reports[0] || report === reports[1]) {
      assert.deepEqual(printed, report);
      assert.equal(code, report === reports[0] ? 0 : 1);
    } else {
      assert.equal(code, 1);
      assert.equal(printed.ok, false);
      assert.equal(printed.diagnostics[0].code, "BUILD_WORKER_FAILED");
    }
  }
});
