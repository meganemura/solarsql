// The few Cloudflare types the example Worker needs, so `tsc` runs here
// without the workers type package. A user project installs
// @cloudflare/workers-types instead of this file.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    readonly ctx: DurableObjectState;
    readonly env: Env;
    fetch(request: Request): Promise<Response>;
  }
}

interface DurableObjectState {
  storage: {
    sql: { exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
    transactionSync<T>(closure: () => T): T;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
