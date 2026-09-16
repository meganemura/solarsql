// Fixture Worker: a Durable Object that runs migrate() (src/durable.ts)
// directly against its own storage, with no module layer above it. Kept
// separate from example/worker.ts so the shipped example's own Durable
// Object class and migration files stay exactly as a deploying project
// uses them; this fixture applies its own migration files instead, chosen
// by the test to exercise a deferred foreign-key violation.
// The path segment after "/" selects the instance by name, so a test gets
// an isolated instance per case, or reuses one to prove it survived a
// failed migrate() call.
import { DurableObject } from "cloudflare:workers";
import { migrate, MigrationHistoryError, type MigrationFile, type StorageLike } from "../src/durable.ts";

type ProbeResult = {
  ok: boolean;
  applied: string[];
  message: string | null;
  isMigrationHistoryError: boolean;
  historyNames: string[];
  childSchema: string | null;
  childRows: Record<string, unknown>[];
};

export class MigrateProbe extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const files = (await request.json()) as MigrationFile[];
    const storage = this.ctx.storage as unknown as StorageLike;
    let applied: string[] = [];
    let message: string | null = null;
    let isMigrationHistoryError = false;
    try {
      applied = migrate(storage, files);
    } catch (e) {
      message = (e as Error).message;
      isMigrationHistoryError = e instanceof MigrationHistoryError;
    }
    const historyNames = storage.sql.exec(`select name from solarsql_migrations order by name`).toArray().map((r) => String(r.name));
    const schemaRow = storage.sql.exec(`select sql from sqlite_schema where name = 'child'`).toArray()[0] as { sql: string } | undefined;
    const childRows = schemaRow ? storage.sql.exec(`select * from child`).toArray() : [];
    const result: ProbeResult = { ok: message === null, applied, message, isMigrationHistoryError, historyNames, childSchema: schemaRow?.sql ?? null, childRows };
    return Response.json(result);
  }
}

export default {
  async fetch(request: Request, env: { PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const name = new URL(request.url).pathname.replace(/^\//, "") || "default";
    const id = env.PROBE.idFromName(name);
    return env.PROBE.get(id).fetch(new Request("http://do/", { method: "POST", body: await request.text() }));
  },
};
