// Responsibility: run an assert-shaped insert many times inside one
// Durable Object, in two text shapes, for spike/15's own driver to sample
// workerd's RSS around.
// Boundary: no solarsql adapter code here on purpose (ADR 0086's amendment
// changed only the SQL text and the bound values, not the guard table's
// shape), so the two modes below stay minimal and symmetric: `before` is
// the token written into the text as a literal, the shape assertStatement()
// used to emit; `after` is the token bound as this statement's own value,
// the shape it emits now.
import { DurableObject } from "cloudflare:workers";

type Exec = { exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[] } };

export class AssertCache extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") === "after" ? "after" : "before";
    const runs = Number(url.searchParams.get("runs") ?? "1000");
    const sql = (this.ctx.storage as unknown as { sql: Exec }).sql;
    sql.exec("create table if not exists solarsql_assert (name text not null, ok integer not null) strict").toArray();
    for (let i = 0; i < runs; i++) {
      const token = crypto.randomUUID();
      if (mode === "before") {
        sql.exec(`insert into solarsql_assert (name, ok) select 'solarsql:assert:${token}:always_true', (case when (1 = 1) then 1 else 0 end)`).toArray();
      } else {
        sql.exec("insert into solarsql_assert (ok, name) select (case when (1 = 1) then 1 else 0 end), 'solarsql:assert:' || ? || ':always_true'", token).toArray();
      }
      sql.exec("delete from solarsql_assert").toArray();
    }
    return new Response("ok");
  }
}

export default {
  async fetch(request: Request, env: { CACHE: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } } }): Promise<Response> {
    return env.CACHE.get(env.CACHE.idFromName("cache")).fetch(request.url);
  },
};
