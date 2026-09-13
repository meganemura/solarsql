// Responsibility: measure repeated SQLite backups and validate snapshot identity.
// Boundary: diagnostic evidence on one runtime; this does not establish a latency guarantee.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscribe } from "node:diagnostics_channel";
import { rehearse } from "../src/build/rehearse.ts";

const count = Number(process.argv[2] ?? 10);
const thresholdMs = Number(process.argv[3] ?? 1_000);
if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
  throw new Error("Use an iteration count from 1 to 100 and a positive slow-phase threshold in milliseconds.");
}
const directory = process.env.SOLARSQL_BACKUP_PROBE_DIR;
if (!directory) {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-backup-probe-"));
  try {
    // An outer process can bound a blocked native operation and remove its fixtures.
    const child = spawnSync(process.execPath, [import.meta.filename, String(count), String(thresholdMs)], {
      env: { ...process.env, SOLARSQL_BACKUP_PROBE_DIR: dir, TMPDIR: dir, TMP: dir, TEMP: dir }, encoding: "utf8",
      timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of (child.stdout ?? "").split("\n")) {
      if (!line) continue;
      (line.startsWith("{") ? process.stdout : process.stderr).write(line + "\n");
    }
    process.stderr.write(child.stderr ?? "");
    console.log(JSON.stringify({ kind: "completion", node: process.version, status: child.status, signal: child.signal, error: child.error?.message }));
    process.exitCode = child.status === 0 && !child.error ? 0 : 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  await test("production rehearsal sequence", async () => {
  let slow = false;
  let iteration = 0;
  let mode = "delete";
  subscribe("solarsql.rehearse", message => {
    const event = message as { phase: string; event: string; ms?: number };
    slow ||= (event.ms ?? 0) > thresholdMs;
    writeSync(1, JSON.stringify({ kind: "phase", iteration, mode, ...event }) + "\n");
  });
  for (mode of ["delete", "wal"]) {
    const path = join(directory, `${mode}.sqlite`);
    const owner = new DatabaseSync(path);
    try {
      owner.exec(`pragma journal_mode = ${mode}; create table items(id integer, value text not null); insert into items(rowid,id,value) values(42,1,'kept')`);
      // The rollback-journal fixture matches a closed application database.
      // The WAL fixture keeps its connection open so committed rows remain in WAL.
      if (mode === "delete") owner.close();
      const original = readFileSync(path);
      const changes = [
        "alter table items add column extra text", "alter table items drop column value", "delete from items",
        "insert into items values (2, null)", `attach database '${path.replaceAll("'", "''")}' as source; delete from source.items`, "commit",
      ];
      for (iteration = 0; iteration < count; iteration++) {
        const report = await rehearse(path, changes[iteration % changes.length]!, {
          queries: { old: "select id, value from items where id = :id" },
          assertions: { identity: "select count(*) = 1 and min(rowid) = 42 and min(value) = 'kept' from items" },
        });
        assert.equal(report.ok, iteration % changes.length === 0, JSON.stringify(report));
        assert.deepEqual(readFileSync(path), original);
        const check = new DatabaseSync(path, { readOnly: true });
        try { assert.equal(check.prepare("select rowid from items").get()!.rowid, 42); }
        finally { check.close(); }
      }
    } finally { if (owner.isOpen) owner.close(); }
  }
  process.exitCode = slow ? 1 : 0;
  });
}
