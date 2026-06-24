#!/usr/bin/env bash
#
# record-saga.sh — one command to (re)build the "@demlik/tea/workflow Saga" demo.
#   1. run the REAL demo (runDemo + narrateDemo) and capture its authentic bytes
#      — every committed/compensated list, status, output, and trace step on screen
#   2. synthesize demo/saga.cast (make-saga-cast.py) — adds title/voiceover/pacing
#   3. render demo/saga.gif with agg
#
# The cast is a paced dramatization, but every step it shows is captured live here
# from the actual demo — change the engine, re-run this, the cast updates. The
# dramatic beat is the ship failure → the rollback running in strict reverse.
# Present live:  asciinema play packages/tea/demo/saga.cast
set -u
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # packages/tea/demo
PKG="$(cd "$DEMO/.." && pwd)"                            # packages/tea
CAP="${CAP:-/tmp/saga}"
mkdir -p "$CAP"

# 1 · capture the REAL demo output (the exact bytes `pnpm demo:saga` prints).
#     tsx isn't a workspace dependency, so resolve it via `pnpm dlx` (cached).
( cd "$PKG" && pnpm dlx tsx@4.21.0 -e "
import { runDemo, narrateDemo } from './src/workflow/demo.ts';
process.stdout.write(narrateDemo(runDemo()));
" ) > "$CAP/narrate.txt"

lines=$(wc -l < "$CAP/narrate.txt")
[ "$lines" -gt 20 ] || { echo "capture looks empty ($lines lines) — aborting"; exit 1; }

# 2 · synthesize + 3 · render
CAP="$CAP" python3 "$DEMO/make-saga-cast.py" > "$DEMO/saga.cast"
agg --font-size 18 "$DEMO/saga.cast" "$DEMO/saga.gif" >/dev/null 2>&1

echo "· captured $lines lines of real demo output"
echo "· wrote demo/saga.cast ($(wc -c <"$DEMO/saga.cast") bytes) + demo/saga.gif ($(wc -c <"$DEMO/saga.gif") bytes)"
echo "done. preview live with:  asciinema play packages/tea/demo/saga.cast"
