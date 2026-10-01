// Responsibility: give the test process a process.send before machine.ts loads.
// Boundary: it defines send only when the process has none; it sends nothing.
// Mutation testing runs Vitest in worker threads, which have no process.send.
// A mutant that forces worker mode would then throw while the module loads,
// and the file would report no test at all instead of a failing one.
if (typeof process.send !== "function") process.send = () => true;
