// Responsibility: run queries and commands on a D1 binding.
// A command becomes one batch() call, and the batch is one transaction on
// D1. A batch of reads is one batch() call too: one round trip for several
// queries. An assert that fails aborts the batch, a constraint that rejects a
// row aborts it too, and the adapter turns both into a value that says
// which. Every other error is thrown.
// Boundary: no SQL is composed here beyond the assert statement that
// runtime/plan.ts defines. Types come from the generated file through the
// query and command objects.
import type { AdapterOptions, BatchRows, Command, CommandResult, Database, Entry, GeneratedMap, ParamsArg, PlanShape, Query, Read, Row, SqlValue, StatementMeta } from "./index.ts";
import { GUARD_CLEANUP, assertFailure, assertStatement, assertToken, bindValues, constraintFailure, engineMeta, observed, outcomeOf, parseJson, validateParams } from "./runtime/plan.ts";

// The part of the D1 binding this adapter uses. Structural, so no type
// package is needed.
export type D1Like = {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<{ results?: unknown; meta?: unknown }[]>;
};

export type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  all(): Promise<{ results?: unknown; meta?: unknown }>;
};

export function d1(binding: D1Like, options: AdapterOptions = {}): Database {
  const prepared = (sql: string, meta: StatementMeta, params: Record<string, unknown>) => binding.prepare(sql).bind(...bindValues(meta, params));

  const all = <Q extends Query<string, Entry>>(query: Q, ...args: ParamsArg<Q>): Promise<Row<Q>[]> =>
    observed(options.observe, "query", query.name, async (report) => {
      const params=(args[0] ?? {}) as Record<string, unknown>;
      validateParams([query.meta], params, `query ${query.name}`);
      const result = await prepared(query.sql, query.meta, params).all();
      report(engineMeta([result]));
      return parseJson<Row<Q> & Record<string, unknown>>((result.results ?? []) as Record<string, unknown>[], query.meta.json, "d1");
    }, () => "ok");

  return {
    all,
    async first(query, ...args) {
      const rows = await all(query, ...args);
      return rows[0] ?? null;
    },
    batch: <const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>> =>
      observed(options.observe, "batch", reads.map((r) => r.query.name).join("+"), async (report) => {
        for (const item of reads) validateParams([item.query.meta], item.params, `query ${item.query.name}`);
        const results = await binding.batch(reads.map((r) => prepared(r.query.sql, r.query.meta, r.params)));
        report(engineMeta(results));
        return reads.map((r, i) => parseJson((results[i]?.results ?? []) as Record<string, unknown>[], r.query.meta.json, "d1")) as unknown as BatchRows<R>;
      }, () => "ok"),
    run: <C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> =>
      observed(options.observe, "command", command.name, async (report) => {
        const params = (args[0] ?? {}) as Record<string, SqlValue>;
        validateParams([...command.meta.statements, ...(command.meta.returns ? [command.meta.returns] : [])], params, `command ${command.name}`);
        const token = assertToken();
        const hasAssert = command.plan.some((item) => typeof item !== "string");
        const statements = command.plan.map((item, i) => {
          const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate, token);
          return prepared(sql, command.meta.statements[i]!, params);
        });
        if (command.returns !== null) statements.push(prepared(command.returns, command.meta.returns!, params));
        // A passing assert's row has no further use once the plan and its
        // returns clause have read what they need; deleting it here, last,
        // keeps the guard table at zero rows between commands (ADR 0093).
        if (hasAssert) statements.push(binding.prepare(GUARD_CLEANUP));
        let results: { results?: unknown; meta?: unknown }[];
        try {
          results = await binding.batch(statements);
          report(engineMeta(results));
        } catch (e) {
          const failed = assertFailure(e, command.meta.asserts, token);
          if (failed !== null) return { ok: false, kind: "assert", assert: failed } as CommandResult<C>;
          const constraint = constraintFailure(e);
          if (constraint !== null) return { ok: false, ...constraint } as CommandResult<C>;
          throw e;
        }
        // One reply per statement, in plan order. An assert is a guard-table
        // insert and the cleanup above is a guard-table delete; both sit
        // outside command.plan, so only the plan's own SQL strings are
        // summed here. A reply without a number counts 0.
        const changes = command.plan.reduce((sum, item, i) => {
          if (typeof item !== "string") return sum;
          const value = (results[i]?.meta as { changes?: unknown } | undefined)?.changes;
          return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
        }, 0);
        if (command.returns !== null) {
          // The returns reply sits right after the plan's own statements,
          // whether or not a cleanup delete follows it.
          const returnsReply = results[command.plan.length];
          const rows = parseJson((returnsReply?.results ?? []) as Record<string, unknown>[], command.meta.returns!.json, "d1");
          return { ok: true, rows, changes } as CommandResult<C>;
        }
        // ADR 0136: with no `returns`, a marked DELETE ... RETURNING plan
        // item is the command's row source. D1's batch() replies one
        // D1Result per statement, in order, so that item's own reply
        // already holds the rows the DELETE returned.
        if (command.returningIndex !== null) {
          const reply = results[command.returningIndex];
          const rows = parseJson((reply?.results ?? []) as Record<string, unknown>[], command.meta.statements[command.returningIndex]!.json, "d1");
          return { ok: true, rows, changes } as CommandResult<C>;
        }
        return { ok: true, rows: [], changes } as unknown as CommandResult<C>;
      }, (r) => outcomeOf(r as { ok: boolean; kind?: string; assert?: string })),
  };
}
