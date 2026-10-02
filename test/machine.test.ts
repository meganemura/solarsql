// Responsibility: exercise worker messages and report validation in the test process.
// Boundary: fixtures supply child behavior; these tests run the parent in-process.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const parentFixture = fileURLToPath(new URL("./fixtures/machine-parent.ts", import.meta.url));
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const parentRoots: string[] = [];
const parentChildren: ChildProcess[] = [];
const parentExceptions: unknown[] = [];
const rehearsalReceipts: string[] = [];

function timeoutTest(name: string, body: () => Promise<void>) {
  test(name, async () => {
    // Timer exceptions reach Vitest as unhandled errors outside the test.
    // Collect them here so this test can fail with an assertion.
    const listeners = process.rawListeners("uncaughtException");
    const exceptions: unknown[] = [];
    process.removeAllListeners("uncaughtException");
    savedOn.call(process, "uncaughtException", error => { exceptions.push(error); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await body();
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const listener of listeners) savedOn.call(process, "uncaughtException", listener);
      assert.deepEqual(exceptions, [], "The deadline timer must not throw.");
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of parentChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const receipt of rehearsalReceipts.splice(0)) {
    if (!existsSync(receipt)) continue;
    const [root] = JSON.parse(readFileSync(receipt, "utf8"));
    // A deleted cleanup branch can leave the fixture's snapshot behind.
    if (typeof root === "string" && dirname(root) === tmpdir()) parentRoots.push(root);
  }
  for (const root of parentRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  assert.deepEqual(parentExceptions.splice(0), []);
});

function parentRoot() {
  const root = mkdtempSync(join(tmpdir(), "solarsql-parent-test-"));
  parentRoots.push(root);
  return root;
}

async function parentChannel(error?: Error) {
  const channel = await load("other", "other");
  assert.equal(channel.machine.isReportWorker(), false);
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
  const emit = ChildProcess.prototype.emit;
  vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (this: ChildProcess, event, ...args) {
    if (event === "message" && args[0] === "fixture-ping" && this.connected) this.send("fixture-pong");
    if (event === "message" && args[0] === "fixture-ready") {
      // Wait for the child's messages and files before advancing its deadline.
      // A real timer keeps a thrown deadline error on the uncaught-error path.
      realSetTimeout(() => {
        try {
          if (vi.isFakeTimers()) vi.advanceTimersByTime(1000);
        } finally {
          if (!this.killed && this.connected) this.send("fixture-release");
        }
      }, 0);
    }
    if (event === "spawn") {
      parentChildren.push(this);
    }
    // Listener exceptions must fail this test instead of escaping into the runner.
    try {
      if (event === "spawn" && error) emit.call(this, "error", error);
      return emit.call(this, event, ...args);
    }
    catch (exception) { parentExceptions.push(exception); return false; }
  });
  return { ...channel, errors };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error("The parent did not settle within 10 seconds.")), 10_000);
    })]);
  } finally { realClearTimeout(timer); }
}

function reportOutput() {
  const writes = captureOutput();
  process.stdout.write = ((text: string, callback: Callback) => {
    writes.push({ text, callback });
    callback(null);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    assert.equal(writes.length, 1);
    return JSON.parse(writes[0]!.text);
  };
}

const defaultAction = "Check stderr for application import output and premature process termination.";

function failedReport(message: string, code = "BUILD_WORKER_FAILED", action = defaultAction, timeoutMs?: number) {
  return { version: 1, ok: false, diagnostics: [{ code, message, ...(timeoutMs === undefined ? {} : { timeoutMs }), action }] };
}

for (const [label, options, exit, signal] of [
  ["no reports", { count: 0 }, 0, null],
  ["two reports", { count: 2 }, 0, null],
  ["successful report with exit one", { code: 1 }, 1, null],
  ["failed report with exit zero", { ok: false, code: 0 }, 0, null],
  ["report followed by a signal", { signal: true }, null, "SIGKILL"],
] as const) {
  test(`machine rejects ${label} with the default failure diagnostic`, async () => {
    const { machine } = await parentChannel();
    const report = reportOutput();
    assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "report-case", ...options })], { timeoutMs: 5000 })), 1);
    const child = parentChildren.at(-1)!;
    assert.deepEqual(report(), failedReport(`The process ended without one valid report (exit ${child.exitCode}, signal ${child.signalCode}).`));
    // On Windows, Node's process.kill ends the process abruptly instead of
    // sending a POSIX signal, so the exit values it reports can differ.
    if (signal === null) assert.deepEqual([child.exitCode, child.signalCode], [exit, null]);
    else assert.notEqual(child.exitCode, 0);
  });
}

for (const field of ["protocol", "token", "type", "null"]) {
  test(field === "null" ? "machine ignores a null report message" : `machine ignores a report message with an invalid ${field}`, async () => {
    const { machine } = await parentChannel();
    const report = reportOutput();
    assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "report-case", field, value: "wrong" })], { timeoutMs: 5000 })), 0);
    assert.deepEqual(report(), { version: 1, ok: true, diagnostics: [] });
  });
}

test("machine reports a child error even with a valid report and exit zero", async () => {
  const { machine } = await parentChannel(new Error("worker channel failed"));
  const report = reportOutput();
  assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "report-case" })], { failureCode: "CUSTOM_FAILURE", action: "Inspect the worker." })), 1);
  assert.deepEqual(report(), failedReport("worker channel failed", "CUSTOM_FAILURE", "Inspect the worker."));
});

for (const custom of [false, true]) {
  timeoutTest(`machine timeout diagnostic uses ${custom ? "custom" : "default"} code and action`, async () => {
    const { machine } = await parentChannel();
    const report = reportOutput();
    const options = custom ? { timeoutMs: 1000, timeoutCode: "CUSTOM_TIMEOUT", action: "Inspect the budget." } : { timeoutMs: 1000 };
    assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "wait", delay: 3000 })], options)), 1);
    assert.equal(parentChildren.at(-1)!.signalCode, "SIGKILL");
    assert.deepEqual(report(), failedReport("The operation exceeded its 1000ms time budget.", custom ? "CUSTOM_TIMEOUT" : "WORKER_TIMEOUT", custom ? "Inspect the budget." : defaultAction, 1000));
  });
}

timeoutTest("machine report cancels the deadline before the child closes", async () => {
  const { machine } = await parentChannel();
  const report = reportOutput();
  assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "report-case", delay: 50 })], { timeoutMs: 1000 })), 0);
  assert.deepEqual(report(), { version: 1, ok: true, diagnostics: [] });
  assert.equal(vi.getTimerCount(), 0);
});

timeoutTest("machine without a timeout accepts a report after the clock advances", async () => {
  const { machine } = await parentChannel();
  const report = reportOutput();
  // Send the report after fixture-ready so an accidental zero-budget timer fires first.
  assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "report-case", delay: 0, waitBefore: true })])), 0);
  assert.deepEqual(report(), { version: 1, ok: true, diagnostics: [] });
  assert.equal(parentChildren.at(-1)!.exitCode, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("machine clears its deadline when a child closes without a report", async () => {
  const { machine } = await parentChannel();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const report = reportOutput();
  assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "failure" })], { timeoutMs: 5000 })), 1);
  assert.deepEqual(report(), failedReport("The process ended without one valid report (exit 7, signal null)."));
  assert.equal(vi.getTimerCount(), 0);
});

test("machine rejects primitive, array, and function reports after IPC serialization", async () => {
  const { machine } = await parentChannel();
  await hegel.testAsync(async tc => {
    for (const value of [tc.draw(gs.integers()), tc.draw(gs.text()), tc.draw(gs.booleans()), tc.draw(gs.arrays(gs.integers()))]) {
      const report = reportOutput();
      assert.equal(await bounded(machine.runMachine(fileURLToPath(new URL("./fixtures/machine-report.ts", import.meta.url)), [JSON.stringify(value)], { timeoutMs: 5000 })), 1);
      assert.equal(report().diagnostics[0].code, "BUILD_WORKER_FAILED");
    }
  }, { testCases: 5 });
  const report = reportOutput();
  assert.equal(await bounded(machine.runMachine(parentFixture, ["inspect", JSON.stringify({ mode: "function-report" })], { timeoutMs: 5000 })), 1);
  assert.equal(report().diagnostics[0].code, "BUILD_WORKER_FAILED");
});

test("rehearsal removes nested snapshots and returns the worker report", async () => {
  const { machine } = await parentChannel();
  const receipt = join(parentRoot(), "receipt.json");
  rehearsalReceipts.push(receipt);
  const report = reportOutput();
  assert.equal(await bounded(machine.runRehearsalProcess(parentFixture, ["rehearse", JSON.stringify({ mode: "report", receipt })], 5000)), 0);
  assert.deepEqual(report(), { version: 1, ok: true, diagnostics: [] });
  const [root, tmp, temp] = JSON.parse(readFileSync(receipt, "utf8"));
  assert.match(basename(root), /^solarsql-rehearse-run-/);
  assert.equal(tmp, root);
  assert.equal(temp, root);
  assert.equal(existsSync(root), false);
});

test("rehearsal cleanup accepts a root already removed by the worker", async () => {
  const { machine } = await parentChannel();
  const receipt = join(parentRoot(), "receipt.json");
  rehearsalReceipts.push(receipt);
  const report = reportOutput();
  assert.equal(await bounded(machine.runRehearsalProcess(parentFixture, ["rehearse", JSON.stringify({ mode: "remove-root", receipt })], 5000)), 0);
  assert.equal(report().ok, true);
  assert.equal(existsSync(JSON.parse(readFileSync(receipt, "utf8"))[0]), false);
});

for (const mode of ["failure", "wait"] as const) {
  timeoutTest(`rehearsal reports ${mode === "failure" ? "a failed worker" : "an expired budget"} with its diagnostic and recovery action`, async () => {
    const { machine } = await parentChannel();
    const report = reportOutput();
    assert.equal(await bounded(machine.runRehearsalProcess(parentFixture, ["rehearse", JSON.stringify({ mode, delay: 3000 })], 1000)), 1);
    const diagnostic = report().diagnostics[0];
    assert.equal(diagnostic.code, mode === "failure" ? "REHEARSAL_WORKER_FAILED" : "REHEARSAL_TIMEOUT");
    assert.equal(diagnostic.action, "Inspect the proposed SQL and source workload. Set --timeout-ms to a larger positive budget if the work requires more time.");
  });
}

test("human worker preserves exit codes without printing an error", async () => {
  const { machine, errors } = await parentChannel();
  await hegel.testAsync(async tc => {
    const code = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
    assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "wait", delay: 0, code })], 5000)), code);
    assert.deepEqual(errors, []);
  }, { testCases: 8 });
});

test("human worker returns failure after signal termination", async () => {
  const { machine, errors } = await parentChannel();
  assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "signal" })], 5000)), 1);
  assert.deepEqual(errors, []);
});

test("human worker reports a child error even when the child exits with another code", async () => {
  // A real fork still supplies close and exit; only the asynchronous error is injected.
  const { machine, errors } = await parentChannel(new Error("worker channel failed"));
  assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "failure" })], 5000)), 1);
  assert.deepEqual(errors, ["error: worker channel failed"]);
});

for (const command of ["migration", "build", "query"]) for (const announced of [false, true]) for (const present of [false, true]) {
  timeoutTest(`human timeout: ${command}, announced=${announced}, present=${present}`, async () => {
    const { machine, errors } = await parentChannel();
    const root = parentRoot();
    const path = join(root, "migration.lock");
    const receipt = join(root, "receipt");
    if (present) writeFileSync(path, "lock");
    assert.equal(await bounded(machine.runHuman(parentFixture, [command, JSON.stringify({ mode: announced ? "lock" : "wait", path, receipt, delay: 3000 })], 1000)), 1);
    assert.equal(parentChildren.at(-1)!.signalCode, "SIGKILL");
    if (announced) assert.equal(readFileSync(receipt, "utf8"), "acknowledged");
    const lock = command !== "query" && announced && present
      ? ` The migration lock remains at ${path}. Inspect it and remove it only after this worker has stopped.` : "";
    assert.deepEqual(errors, [`error: The operation exceeded its 1000ms time budget. Inspect the configuration import and generated output before you set --timeout-ms to a larger positive budget.${lock}`]);
  });
}

timeoutTest("human parent acknowledges only the first valid lock message", async () => {
  const { machine, errors } = await parentChannel();
  const root = parentRoot();
  const path = join(root, "migration.lock");
  const receipt = join(root, "messages.jsonl");
  writeFileSync(path, "lock");
  writeFileSync(receipt, "");
  assert.equal(await bounded(machine.runHuman(parentFixture, ["migration", JSON.stringify({ mode: "raw-lock", path, receipt, delay: 3000 })], 1000)), 1);
  const messages = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { protocol: "solarsql.direct-worker.v1", token: messages[0].token, type: "migration-lock-ack", nonce: "accepted" });
  assert.match(messages[0].token, /^[0-9a-f-]{36}$/);
  assert.match(errors[0]!, /The migration lock remains at /);
});

timeoutTest("worker done cancels the deadline while the child finishes exiting", async () => {
  const { machine, errors } = await parentChannel();
  assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "done", code: 7, delay: 50 })], 1000)), 7);
  assert.deepEqual(errors, []);
});

for (const [field, value] of [["protocol", "wrong"], ["token", "wrong"], ["type", "wrong"], ["code", "7"]] as const) {
  timeoutTest(`human parent ignores worker done with an invalid ${field}`, async () => {
    const { machine, errors } = await parentChannel();
    assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "raw-done", field, value, delay: 3000 })], 1000)), 1);
    assert.match(errors[0]!, /exceeded its 1000ms time budget/);
  });
}

timeoutTest("human parent ignores a null control message", async () => {
  const { machine, errors } = await parentChannel();
  const receipt = join(parentRoot(), "messages.jsonl");
  writeFileSync(receipt, "");
  assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "raw-lock", path: "missing.lock", receipt, delay: 3000 })], 1000)), 1);
  assert.match(errors[0]!, /exceeded its 1000ms time budget/);
});

test("human parent releases its deadline after the child closes", async () => {
  const { machine, errors } = await parentChannel();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  assert.equal(await bounded(machine.runHuman(parentFixture, ["query", JSON.stringify({ mode: "wait", delay: 0, code: 7 })], 5000)), 7);
  assert.deepEqual(errors, []);
  assert.equal(vi.getTimerCount(), 0);
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
