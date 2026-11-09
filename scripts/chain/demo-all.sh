#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "$#" -gt 0 ]; then
  # Preserve C's existing scenario/JSON/log flags and fixture-only semantics.
  exec pnpm exec tsx scripts/demo/run-all.ts "$@"
fi
exec bash scripts/chain/test.sh
