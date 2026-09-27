// Responsibility: open() and applied() each promise a private database
// scoped to the call, backed by ":memory:". SQLite treats ":memory:" and ""
// (an empty filename, also private and per-connection) differently: only
// ":memory:" is unconditionally memory-backed, regardless of the build's
// `PRAGMA temp_store` default. A real ":memory:" database always reports
// `journal_mode` "memory", the one mode it can ever have (measured: this
// build's "" instead reports "delete", a real on-disk rollback journal).
// That report is the portable, SQL-observable proof that these functions
// keep their promise.
import { test } from "vitest";
import assert from "node:assert/strict";
import { applied, open } from "../src/build/migration.ts";

test("open()'s database is genuinely in-memory: its journal_mode is \"memory\"", () => {
  const db = open([]);
  try {
    const mode = db.prepare("pragma journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "memory");
  } finally {
    db.close();
  }
});

test("applied()'s database is genuinely in-memory: its journal_mode is \"memory\"", () => {
  const db = applied([]);
  try {
    const mode = db.prepare("pragma journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "memory");
  } finally {
    db.close();
  }
});
