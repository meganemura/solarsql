// The example project: three modules on one database.
// `library` points at the source of this repository. A user project omits
// it and gets "solarsql".
import { config } from "../src/index.ts";

export default config({
  // orders comes first: customers.remove includes orders.deleteByCustomer
  // (ADR 0127), and the owner of an included command must build first.
  modules: ["./modules/orders", "./modules/customers", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
  library: "../../../src/index.ts",
});
