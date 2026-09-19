// Responsibility: parse one agent's stdout, in Claude Code's
// `--output-format stream-json` shape (one JSON object per line), into the
// four numbers the battery reports. This is the only file that knows that
// shape; a different agent CLI needs only a new parser with this same
// return type.
// Boundary: this file does not judge success -- run.ts decides that from
// check(), not from the stream.
//
// A real `claude -p --output-format stream-json --verbose` run also emits
// "system" (hook_started, hook_response, commands_changed, init,
// thinking_tokens) and "rate_limit_event" lines; every line whose type is
// not assistant, user, or result, and every non-JSON line, is ignored below.
export type Metrics = { filesRead: number; filesEdited: number; failedCommands: number; toolCalls: number; durationMs: number; costUsd: number | null; turns: number | null };

// JSON.parse gives unknown shape; every field below is read defensively
// (an absent or mistyped one is skipped, not thrown) since a real agent CLI
// version can add fields this parser has never seen.
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseStream(stdout: string, fallbackDurationMs: number): Metrics {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>(); // distinct file_path of Edit and Write tool_use (ntky-30, hunksOutsideTask's sibling metric)
  let searchReads = 0; // one per Glob or Grep tool_use, uncounted by distinct path
  let toolCalls = 0;
  let failedCommands = 0;
  let durationMs = fallbackDurationMs;
  let costUsd: number | null = null;
  let turns: number | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // a non-JSON line (agent chatter) does not describe a tool call
    }
    const event = record(parsed);
    if (!event) continue;
    const message = record(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];

    if (event.type === "assistant") {
      for (const item of content) {
        const use = record(item);
        if (!use || use.type !== "tool_use") continue;
        toolCalls++;
        const input = record(use.input);
        const filePath = input?.file_path;
        if (use.name === "Read" && typeof filePath === "string") filesRead.add(filePath);
        else if (use.name === "Glob" || use.name === "Grep") searchReads++;
        else if ((use.name === "Edit" || use.name === "Write") && typeof filePath === "string") filesEdited.add(filePath);
      }
    } else if (event.type === "user") {
      for (const item of content) {
        const result = record(item);
        if (result && result.type === "tool_result" && result.is_error === true) failedCommands++;
      }
    } else if (event.type === "result") {
      if (typeof event.duration_ms === "number") durationMs = event.duration_ms;
      if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
      if (typeof event.num_turns === "number") turns = event.num_turns;
    }
  }

  return { filesRead: filesRead.size + searchReads, filesEdited: filesEdited.size, failedCommands, toolCalls, durationMs, costUsd, turns };
}

// A diff hunk whose added or removed lines name a table outside
// `taskTables` -- the harmful-edit count the module-ownership study
// measures (ntky-30's spec, "Measure it from the saved .diff"). A hunk
// counts once any of its changed lines contains a whole-word match of a
// name in `knownTables` (the project's full table set, so an unrelated
// English word in a comment -- "from the declared schema", every migration
// file's own boilerplate -- can never match) that is not in `taskTables`.
export function countHunksOutsideTask(diffText: string, taskTables: readonly string[], knownTables: readonly string[]): number {
  const task = new Set(taskTables);
  const outsideNames = knownTables.filter(name => !task.has(name));
  if (outsideNames.length === 0) return 0;
  const pattern = new RegExp(`\\b(?:${outsideNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
  let count = 0;
  let inHunk = false;
  let outside = false;
  const flush = () => { if (inHunk && outside) count++; };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      inHunk = true;
      outside = false;
      continue;
    }
    if (!inHunk || line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (pattern.test(line)) outside = true;
  }
  flush();
  return count;
}
