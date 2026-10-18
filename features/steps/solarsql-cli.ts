// Runs the installed package's own bin entry in a scratch project, the way
// a user runs `npx solarsql`, with no reference back to this checkout's
// source: the scenario is about what the published package does.
import { runCommand } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CliResult {
  exitCode: number;
  stdout: string;
}

export async function runSolarsql(project: string, args: string[]): Promise<CliResult> {
  const manifest = JSON.parse(readFileSync(join(project, "node_modules/solarsql/package.json"), "utf8")) as { bin: { solarsql: string } };
  const result = await runCommand(process.execPath, [join(project, "node_modules/solarsql", manifest.bin.solarsql), ...args], { cwd: project });
  return { exitCode: result.exitCode ?? 1, stdout: `${result.stdout}${result.stderr}` };
}
