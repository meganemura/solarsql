// Responsibility: supply one report to a parent's validation test.
// Boundary: this fixture does not execute CLI commands or application imports.
import { announceWorkerStarted, printReport } from "../../src/build/machine.ts";

await announceWorkerStarted();

const report = JSON.parse(process.argv[2]!);
await printReport(report);
process.exitCode = report?.ok === false ? 1 : 0;
