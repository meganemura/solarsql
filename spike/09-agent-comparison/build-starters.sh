#!/bin/zsh
# Build the two starter projects of the agent comparison in a work
# directory, check them, and make the run directories.
#   spike/09-agent-comparison/build-starters.sh [work dir] [runs per arm] [experiment]
# Experiment 2 adds the inventory table to both arms and uses exp2/task.md
# and exp2/hidden.test.ts.
# The work directory defaults to a temporary one. The Drizzle arm installs
# drizzle-orm there, and nothing in this repository.
set -euo pipefail
KIT=${0:a:h}
REPO=${KIT:h:h}
WORK=${1:-$(mktemp -d -t solarsql-agent-comparison)}
RUNS=${2:-3}
EXPNO=${3:-1}
if [[ $EXPNO == 1 ]]; then TASK=$KIT/task.md; HIDDEN=$KIT/hidden/hidden.test.ts; else TASK=$KIT/exp2/task.md; HIDDEN=$KIT/exp2/hidden.test.ts; fi
MF=miniflare@5.20260828.0-alpha
TS=typescript@7.0.2
TYPES=@types/node@26.4.0
DRIZZLE=drizzle-orm@0.45.2
NPMI=(npm install --silent --no-audit --no-fund --safe-chain-skip-minimum-package-age)

rm -rf "$WORK/starters" "$WORK/runs"
mkdir -p "$WORK/starters"
(cd "$REPO" && npm run build --silent && npm pack --silent --pack-destination "$WORK/starters" >/dev/null)
TARBALL=$(ls "$WORK/starters"/solarsql-*.tgz)

common() {
  local dir=$1 lib=$2 libdesc=$3 layout=$4
  mkdir -p "$dir/test" "$dir/migrations"
  cp "$KIT/common/cloudflare.d.ts" "$KIT/common/tsconfig.json" "$dir/"
  cp "$KIT/common/test/harness.ts" "$KIT/common/test/visible.test.ts" "$dir/test/"
  cat > "$dir/package.json" <<EOF
{
  "name": "shop-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "date +%s >> .runs-test.log; node --test \"test/**/*.test.ts\"",
    "typecheck": "date +%s >> .runs-typecheck.log; tsc --noEmit"
  }
}
EOF
  cat > "$dir/AGENTS.md" <<EOF
# AGENTS.md

This project is a Cloudflare Worker on D1. The data layer is $libdesc; its README is at node_modules/$lib/README.md.

- \`npm test\` runs the tests on Miniflare with a local D1. \`npm run typecheck\` runs tsc.
- The tests in test/ send one JSON step per request to worker.ts and check the reply.
- $layout
- migrations/ holds the SQL that wrangler applies; the tests apply it too.
EOF
}

# --- solarsql arm ---------------------------------------------------------
A="$WORK/starters/solarsql"
common "$A" solarsql "solarsql (typed SQL for D1 and Durable Objects)" "modules/ holds one directory per module: schema.ts, queries.ts, commands.ts, public.ts, and the generated types."
cp -R "$REPO/example/modules" "$A/modules"
find "$A/modules" -name "*.ts" -exec sed -i '' -e 's#from "\(\.\./\)*src/index\.ts"#from "solarsql"#' {} +
sed -i '' "s/check (status in ('draft', 'confirmed'))/check (status in ('draft', 'confirmed', 'cancelled'))/" "$A/modules/orders/schema.ts"
cp "$KIT/solarsql-arm/modules/orders/queries.ts" "$A/modules/orders/queries.ts"
cp "$KIT/solarsql-arm/modules/orders/commands.ts" "$A/modules/orders/commands.ts"
cp "$KIT/solarsql-arm/worker.ts" "$KIT/solarsql-arm/solarsql.config.ts" "$A/"
if [[ $EXPNO == 2 ]]; then
  cp "$KIT/exp2/solarsql-arm/modules/orders/"*.ts "$A/modules/orders/"
  cp "$KIT/exp2/solarsql-arm/worker.ts" "$A/"
  cp "$KIT/exp2/common/test/visible.test.ts" "$A/test/"
fi
(cd "$A" && "${NPMI[@]}" "$TARBALL" "$MF" "$TS" "$TYPES")
(cd "$A" && npx solarsql migration initial && npx solarsql build)

# --- drizzle arm ----------------------------------------------------------
B="$WORK/starters/drizzle"
common "$B" drizzle-orm "Drizzle ORM (drizzle-orm with the D1 driver)" "schema.ts declares the tables; worker.ts holds the steps."
cp "$KIT/drizzle-arm/schema.ts" "$KIT/drizzle-arm/worker.ts" "$B/"
cp "$KIT/drizzle-arm/0001_initial.sql" "$B/migrations/"
if [[ $EXPNO == 2 ]]; then
  cp "$KIT/exp2/drizzle-arm/schema.ts" "$KIT/exp2/drizzle-arm/worker.ts" "$B/"
  cp "$KIT/exp2/drizzle-arm/0001_initial.sql" "$B/migrations/"
  cp "$KIT/exp2/common/test/visible.test.ts" "$B/test/"
fi
(cd "$B" && "${NPMI[@]}" "$DRIZZLE" "$MF" "$TS" "$TYPES")

# --- both must be green, and the hidden tests must fail on both -----------
for arm in solarsql drizzle; do
  D="$WORK/starters/$arm"
  echo "== $arm: typecheck"
  (cd "$D" && npx tsc --noEmit)
  echo "== $arm: visible tests"
  (cd "$D" && node --test "test/**/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖")
  echo "== $arm: hidden tests (expected to fail: no cancel step yet)"
  cp "$HIDDEN" "$D/test/hidden.test.ts"
  (cd "$D" && node --test test/hidden.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)" || true)
  rm "$D/test/hidden.test.ts"
  rm -f "$D/.runs-test.log" "$D/.runs-typecheck.log"
done

# --- one copy per run, and the task text with the path filled in ----------
mkdir -p "$WORK/runs"
for arm in solarsql drizzle; do
  for n in $(seq 1 "$RUNS"); do
    cp -R "$WORK/starters/$arm" "$WORK/runs/$arm-$n"
    sed "s#{{DIR}}#$WORK/runs/$arm-$n#g" "$TASK" > "$WORK/runs/task-$arm-$n.md"
  done
done
echo "starters ready in $WORK"
echo "next: give each runs/task-<arm>-<n>.md to one fresh agent, then run collect.sh $WORK"
