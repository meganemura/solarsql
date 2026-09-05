// The example project: three modules on one database.
// `library` points at the source of this repository. A user project omits
// it and gets "solarsql".
import { config } from "../src/index.ts";

export default config({
  modules: ["./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
  library: "../../../src/index.ts",
});
