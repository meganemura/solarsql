import { commands, queries, table } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

export const customers = table(`
  -- A customer who places orders.
  create table customers (
    id text primary key not null,
    name text not null,
    email text not null unique
  ) strict
`);

export const customerQueries = queries(generated, {
  byId: `
    -- One customer, or none.
    select id, name, email from customers where id = :id`,
  all: `
    -- Every customer, by name.
    select id, name, email from customers order by name`,
});

export const customerCommands = commands(generated, {
  create: {
    plan: ["insert into customers (id, name, email) values (:id, :name, :email)"],
    returns: "select id, name, email from customers where id = :id",
  },
  // Every customer, gone. The orders that reference them go first, through
  // the orders module's own clear.
  clear: {
    plan: ["delete from customers"],
  },
});
