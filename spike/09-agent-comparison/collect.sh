#!/bin/zsh
# After the agents are done: the agent's own checks, the hidden tests, and
# the diff of each run against its starter, for the rubric.
#   spike/09-agent-comparison/collect.sh <work dir>
set -uo pipefail
KIT=${0:a:h}
WORK=$1
OUT="$WORK/results"
mkdir -p "$OUT"
for D in "$WORK"/runs/*/; do
  D=${D%/}
  run=${D:t}
  arm=${run%-*}
  echo "=== $run"
  echo "--- own tests"; (cd "$D" && node --test "test/**/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)" | tr '\n' ' '); echo
  echo "--- typecheck exit: $(cd "$D" && npx tsc --noEmit >/dev/null 2>&1; echo $?)"
  cp "$KIT/hidden/hidden.test.ts" "$D/test/hidden.test.ts"
  echo "--- hidden"; (cd "$D" && node --test test/hidden.test.ts 2>&1 | tee "$OUT/$run.hidden.txt" | grep -E "^ℹ (tests|pass|fail)|^  ✖")
  rm "$D/test/hidden.test.ts"
  diff -r -u --exclude=node_modules --exclude=".runs-*.log" --exclude=package-lock.json "$WORK/starters/$arm" "$D" > "$OUT/$run.diff" || true
  echo "--- diff lines: $(wc -l < "$OUT/$run.diff"), files: $(grep -c '^diff -r\|^Only in' "$OUT/$run.diff")"
done
echo "then: python3 $KIT/metrics.py $WORK <transcripts dir> > $OUT/metrics.jsonl"
