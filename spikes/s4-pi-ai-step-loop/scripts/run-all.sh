#!/usr/bin/env bash
# Runs every scenario for the default model (claude-sonnet-4-5 catalog entry) and for
# claude-opus-5-5 (mid-conversation effort and native tool-change compat flags), then checks.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/pg.sh status >/dev/null 2>&1 || scripts/pg.sh start
SCENARIOS="baseline kill-between kill-after-tool kill-in-tool kill-in-model cancel-in-model"
for s in $SCENARIOS; do scripts/scenario.sh "$s" 2>&1 | grep -v -e NOTICE -e DeprecationWarning -e trace-warnings; done
for s in $SCENARIOS; do SUFFIX=-opus MODEL_ID=claude-opus-5-5 scripts/scenario.sh "$s" 2>&1 | grep -v -e NOTICE -e DeprecationWarning -e trace-warnings; done
bun scripts/check.ts | tee data/check.txt
SUFFIX=-opus bun scripts/check.ts | tee data/check-opus.txt
