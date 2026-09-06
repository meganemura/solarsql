// What other modules may use from customers: the id type, the queries that
// return plain rows, and the commands.
export type { CustomersId } from "./solarsql.generated.ts";
export { customerQueries, customerCommands } from "./module.ts";
