// Responsibility: quote one argument in a displayed shell command.
// Boundary: this module formats text; it does not execute commands.
export function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
