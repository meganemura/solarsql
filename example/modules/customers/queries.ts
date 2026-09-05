import { queries } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

export const customerQueries = queries(generated, {
  byId: `
    -- One customer, or none.
    select id, name, email from customers where id = :id`,
  all: `
    -- Every customer, by name.
    select id, name, email from customers order by name`,
});
