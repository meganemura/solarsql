import { commands } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

export const customerCommands = commands(generated, {
  create: {
    plan: ["insert into customers (id, name, email) values (:id, :name, :email)"],
    returns: "select id, name, email from customers where id = :id",
  },
});
