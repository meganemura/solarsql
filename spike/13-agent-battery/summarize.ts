#!/usr/bin/env node
// Responsibility: print one line per tool call from a battery run's raw
// stream.jsonl, in order -- the tool name, its main argument, and FAILED
// when the matching tool_result reports an error -- then the agent's final
// result text. This is what a reader uses to see where the turns went,
// since run.ts's metrics.jsonl line keeps only the four counted numbers.
// Boundary: this file only formats a stream already on disk; it does not
// compute the summary numbers metrics.ts computes, and does not run an
// agent or a check.
//
// node spike/13-agent-battery/summarize.ts <out>/<scenario>-<run>.stream.jsonl
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// The tool's own argument that tells a reader what it acted on: a file
// path for Read/Edit/Write, a command line for Bash, a pattern for
// Glob/Grep. Truncated so one tool call stays one line.
function mainArg(input: Record<string, unknown> | undefined): string {
  const value = input?.file_path ?? input?.command ?? input?.pattern;
  const text = typeof value === "string" ? value : "";
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

type ToolLine = { name: string; arg: string; failed: boolean };

export function summarize(streamText: string): string {
  const byId = new Map<string, ToolLine>();
  const toolLines: ToolLine[] = [];
  let finalText = "";

  for (const raw of streamText.split("\n")) {
    const trimmed = raw.trim();
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
        const line: ToolLine = { name: typeof use.name === "string" ? use.name : "unknown", arg: mainArg(record(use.input)), failed: false };
        toolLines.push(line);
        if (typeof use.id === "string") byId.set(use.id, line);
      }
    } else if (event.type === "user") {
      for (const item of content) {
        const result = record(item);
        if (!result || result.type !== "tool_result") continue;
        const failed = result.is_error === true;
        const id = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
        const line = id !== undefined ? byId.get(id) : toolLines[toolLines.length - 1];
        if (line && failed) line.failed = true;
      }
    } else if (event.type === "result") {
      if (typeof event.result === "string") finalText = event.result;
      else if (typeof event.error === "string") finalText = event.error;
    }
  }

  const body = toolLines.map(line => `${line.name}\t${line.arg}${line.failed ? " FAILED" : ""}`);
  return [...body, "---", finalText].join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: node spike/13-agent-battery/summarize.ts <stream.jsonl path>");
  console.log(summarize(readFileSync(path, "utf8")));
}
