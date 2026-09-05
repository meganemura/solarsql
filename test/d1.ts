// Test harness for D1 in Miniflare.
// Responsibility: start one Worker with a D1 binding and forward SQL to it.
// Boundary: no schema and no assertions live here. Each test file owns those.
// The Worker runs the SQL through env.DB, so a batch takes the same path as
// production code. The Node side only sends JSON and reads JSON back.
// Miniflare 5 takes a normalized config under `workers`. The v4 flat options
// stay readable in a test, so the harness converts them with the helper the
// package exports for that purpose.
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export type Statement = { sql: string; params?: unknown[] };

export type WorkerOk = { ok: true; results: unknown };
export type WorkerError = {
  ok: false;
  name: string;
  message: string;
  cause: string | null;
};
export type WorkerReply = WorkerOk | WorkerError;

export type Mode = "batch" | "all" | "run" | "first" | "exec";

const script = `
export default {
  async fetch(request, env) {
    const { mode, statements } = await request.json();
    const prepared = () =>
      statements.map((s) => env.DB.prepare(s.sql).bind(...(s.params ?? [])));
    try {
      let results;
      if (mode === "batch") results = await env.DB.batch(prepared());
      else if (mode === "all") results = await prepared()[0].all();
      else if (mode === "run") results = await prepared()[0].run();
      else if (mode === "first") results = await prepared()[0].first();
      else if (mode === "exec") results = await env.DB.exec(statements[0].sql);
      else throw new Error("unknown mode " + mode);
      return Response.json({ ok: true, results });
    } catch (e) {
      return Response.json({
        ok: false,
        name: e.name,
        message: e.message,
        cause: e.cause ? String(e.cause.message ?? e.cause) : null,
      });
    }
  },
};
`;

export class D1Harness {
  readonly mf: Miniflare;

  constructor() {
    this.mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: "2026-08-28",
        d1Databases: { DB: "solarsql-test" },
      }),
    );
  }

  async send(mode: Mode, statements: Statement[]): Promise<WorkerReply> {
    const response = await this.mf.dispatchFetch("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ mode, statements }),
    });
    return (await response.json()) as WorkerReply;
  }

  async exec(sql: string): Promise<WorkerReply> {
    return this.send("exec", [{ sql }]);
  }

  async batch(statements: Statement[]): Promise<WorkerReply> {
    return this.send("batch", statements);
  }

  async all(sql: string, params: unknown[] = []): Promise<WorkerReply> {
    return this.send("all", [{ sql, params }]);
  }

  async first(sql: string, params: unknown[] = []): Promise<WorkerReply> {
    return this.send("first", [{ sql, params }]);
  }

  async run(sql: string, params: unknown[] = []): Promise<WorkerReply> {
    return this.send("run", [{ sql, params }]);
  }

  async dispose(): Promise<void> {
    await this.mf.dispose();
  }
}
