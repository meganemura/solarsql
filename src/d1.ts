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
import { assertFailure, assertStatement, bindValues, constraintFailure, engineMeta, observed, outcomeOf, parseJson } from "./runtime/plan.ts";

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
      const result = await prepared(query.sql, query.meta, (args[0] ?? {}) as Record<string, unknown>).all();
      report(engineMeta([result]));
      return parseJson<Row<Q> & Record<string, unknown>>((result.results ?? []) as Record<string, unknown>[], query.meta.json);
    }, () => "ok");

  return {
    all,
    async first(query, ...args) {
      const rows = await all(query, ...args);
      return rows[0] ?? null;
    },
    batch: <const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>> =>
      observed(options.observe, "batch", reads.map((r) => r.query.name).join("+"), async (report) => {
        const results = await binding.batch(reads.map((r) => prepared(r.query.sql, r.query.meta, r.params)));
        report(engineMeta(results));
        return reads.map((r, i) => parseJson((results[i]?.results ?? []) as Record<string, unknown>[], r.query.meta.json)) as unknown as BatchRows<R>;
      }, () => "ok"),
    run: <C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> =>
      observed(options.observe, "command", command.name, async (report) => {
        const params = (args[0] ?? {}) as Record<string, SqlValue>;
        const statements = command.plan.map((item, i) => {
          const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate);
          return prepared(sql, command.meta.statements[i]!, params);
        });
        if (command.returns !== null) statements.push(prepared(command.returns, command.meta.returns!, params));
        let results: { results?: unknown; meta?: unknown }[];
        try {
          results = await binding.batch(statements);
          report(engineMeta(results));
        } catch (e) {
          const failed = assertFailure(e, command.meta.asserts);
          if (failed !== null) return { ok: false, kind: "assert", assert: failed } as CommandResult<C>;
          const constraint = constraintFailure(e);
          if (constraint !== null) return { ok: false, ...constraint } as CommandResult<C>;
          throw e;
        }
        const changes = command.plan.reduce((sum, item, i) => {
          if (typeof item !== "string") return sum;
          const value = (results[i]?.meta as { changes?: unknown } | undefined)?.changes;
          return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
        }, 0);
        if (command.returns === null) return { ok: true, rows: [], changes } as CommandResult<C>;
        const last = results[results.length - 1];
        const rows = parseJson((last?.results ?? []) as Record<string, unknown>[], command.meta.returns!.json);
        return { ok: true, rows, changes } as CommandResult<C>;
      }, (r) => outcomeOf(r as { ok: boolean; kind?: string; assert?: string })),
  };
}
