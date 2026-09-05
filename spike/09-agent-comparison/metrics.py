"""Metrics of every agent run, from the transcripts and the run directories.

Usage: python3 metrics.py <work dir with runs/> <transcripts dir>

One JSON object per run:
- tool_calls, by_tool
- files_read: distinct files whose contents the agent read, through the
  Read tool or through cat, sed, head, tail, grep in Bash. A shell loop of
  the form `for f in $(find <dir> ...)` or `for f in <glob>` counts every
  file it names.
- files_read_in_node_modules: the part of files_read under node_modules
- cli_help_runs, build_runs: `solarsql --help` and `solarsql build`
- test_runs, typecheck_runs: from the log the npm scripts write, plus any
  direct `node --test` or `tsc` in Bash
- errors: Bash results the harness flagged as errors
- output_tokens: the sum of the assistant's output tokens in the transcript
- wall_seconds: first to last event (runs were concurrent, so not comparable)
"""
import json
import os
import re
import sys

work, tdir = sys.argv[1], sys.argv[2]
runs_dir = os.path.join(work, "runs")
runs = sorted(d for d in os.listdir(runs_dir) if os.path.isdir(os.path.join(runs_dir, d)))

READERS = ("cat", "sed", "head", "tail", "grep", "less", "more")


def load(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("{"):
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def run_dir_of(events):
    for e in events:
        if e.get("type") != "user":
            continue
        c = e.get("message", {}).get("content")
        text = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict))
        m = re.search(r"(/\S+/runs/[a-z]+-\d+)", text)
        if m:
            return m.group(1)
    return None


def files_in_bash(cmd, rd):
    """Files a shell command reads, as paths relative to the run dir."""
    found = set()
    cmd = cmd.replace("\n", " ")
    # for f in $(find <dir> ...); do ... cat "$f"
    for m in re.finditer(r"for \w+ in \$\(find (\S+)", cmd):
        base = os.path.join(rd, m.group(1))
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d != "node_modules"]
            for f in files:
                found.add(os.path.relpath(os.path.join(root, f), rd))
    # for f in <glob>; do ... cat "$f"
    import glob as globmod
    for m in re.finditer(r"for \w+ in ((?:\S+\s)*?\S*\*\S*);", cmd):
        for pattern in m.group(1).split():
            for g in globmod.glob(os.path.join(rd, pattern)):
                if os.path.isfile(g):
                    found.add(os.path.relpath(g, rd))
    # a '|' inside a quoted grep pattern is escaped, and is not a pipe
    for part in re.split(r"&&|\|\||;|(?<!\\)\|", cmd):
        words = part.strip().split()
        if not words:
            continue
        # skip a leading cd, echo, or env prefix
        if words[0] not in READERS:
            continue
        for w in words[1:]:
            w = w.strip("\"'")
            if w.startswith("-") or w in ("2>&1", "2>/dev/null", "/dev/null") or "$" in w:
                continue
            if words[0] == "sed" and (w.startswith("'") or re.match(r"^\d", w)):
                continue
            if words[0] == "grep" and not ("/" in w or "." in w):
                continue
            path = w if w.startswith("/") else os.path.join(rd, w)
            if os.path.isfile(path):
                found.add(os.path.relpath(path, rd))
            elif "*" in w:
                import glob
                for g in glob.glob(path):
                    if os.path.isfile(g):
                        found.add(os.path.relpath(g, rd))
    return found


transcripts = {}
for name in os.listdir(tdir):
    if not (name.endswith(".jsonl") or name.endswith(".output")):
        continue
    events = load(os.path.join(tdir, name))
    d = run_dir_of(events)
    if d:
        transcripts[os.path.basename(d)] = (name, events)

for run in runs:
    rd = os.path.join(runs_dir, run)
    row = {"run": run, "arm": run.rsplit("-", 1)[0]}
    if run not in transcripts:
        print(json.dumps(row))
        continue
    name, events = transcripts[run]
    results = {}
    for e in events:
        if e.get("type") == "user" and isinstance(e.get("message", {}).get("content"), list):
            for x in e["message"]["content"]:
                if isinstance(x, dict) and x.get("type") == "tool_result":
                    results[x["tool_use_id"]] = bool(x.get("is_error"))
    tools, reads, outside, edits = {}, set(), set(), set()
    web = help_runs = build_runs = tests = typechecks = errors = out_tokens = 0
    times = []
    for e in events:
        if e.get("timestamp"):
            times.append(e["timestamp"])
        if e.get("type") != "assistant":
            continue
        msg = e.get("message", {})
        out_tokens += (msg.get("usage") or {}).get("output_tokens", 0)
        for c in msg.get("content", []):
            if c.get("type") != "tool_use":
                continue
            n = c.get("name")
            tools[n] = tools.get(n, 0) + 1
            inp = c.get("input", {})
            if n == "Read":
                p = inp.get("file_path", "")
                if p.startswith(rd):
                    reads.add(os.path.relpath(p, rd))
                else:
                    outside.add(p)
            elif n in ("WebFetch", "WebSearch"):
                web += 1
            elif n in ("Edit", "Write", "MultiEdit"):
                edits.add(os.path.relpath(inp.get("file_path", ""), rd))
            elif n == "Bash":
                cmd = inp.get("command", "")
                reads |= files_in_bash(cmd, rd)
                for p in re.findall(r"(?:cat|sed|head|grep) [^&|;]*?(/(?:Users|private|home)/\S+)", cmd):
                    if not p.startswith(rd):
                        outside.add(p)
                if re.search(r"solarsql(?:\.js)?\s+--help", cmd):
                    help_runs += 1
                if re.search(r"solarsql(?:\.js)?\s+build", cmd):
                    build_runs += 1
                if re.search(r"node --test", cmd):
                    tests += 1
                if re.search(r"\btsc\b", cmd):
                    typechecks += 1
                if results.get(c.get("id")):
                    errors += 1
    for log, key in ((".runs-test.log", "npm_test"), (".runs-typecheck.log", "npm_typecheck")):
        p = os.path.join(rd, log)
        count = sum(1 for _ in open(p)) if os.path.exists(p) else 0
        if key == "npm_test":
            tests += count
        else:
            typechecks += count
    row.update(
        {
            "tool_calls": sum(tools.values()),
            "by_tool": tools,
            "files_read": len(reads),
            "files_read_in_node_modules": sum(1 for p in reads if p.startswith("node_modules/")),
            "files_read_list": sorted(reads),
            "reads_outside_run_dir": sorted(outside),
            "web_calls": web,
            "cli_help_runs": help_runs,
            "build_runs": build_runs,
            "test_runs": tests,
            "typecheck_runs": typechecks,
            "bash_errors": errors,
            "files_edited": sorted(edits),
            "output_tokens": out_tokens,
        }
    )
    if len(times) >= 2:
        from datetime import datetime

        t0 = datetime.fromisoformat(times[0].replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(times[-1].replace("Z", "+00:00"))
        row["wall_seconds"] = round((t1 - t0).total_seconds())
    print(json.dumps(row))
