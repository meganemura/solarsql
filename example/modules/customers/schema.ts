import { table } from "../../../src/index.ts";

export const customers = table(`
  -- A customer who places orders.
  create table customers (
    id text primary key not null,
    name text not null,
    email text not null unique
  ) strict
`);
