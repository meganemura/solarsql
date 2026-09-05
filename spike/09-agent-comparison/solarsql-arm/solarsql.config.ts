import { config } from "solarsql";

export default config({
  modules: ["./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
});
