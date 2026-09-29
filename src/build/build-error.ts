// Responsibility: the error the compiler raises when a schema, a query, or a
// migration cannot be accepted.
// Boundary: no SQL and no filesystem. The schema diff and the file writer
// import this class without importing the typer (typegen.ts).
export class BuildError extends Error {
  readonly sql: string | undefined;
  readonly locations: string[] = [];
  // A short next step for a JSON diagnostic consumer (build --json's own
  // "action" field); undefined when the message has no single next step.
  readonly action: string | undefined;
  constructor(message: string, sql?: string, action?: string) {
    super(sql === undefined ? message : `${message}\n  in: ${sql.replace(/\s+/g, " ").trim()}`);
    this.name = "BuildError";
    this.sql = sql;
    this.action = action;
  }
}
