#!/usr/bin/env bash
#
# record-raft.sh — one command to (re)build the "@demlik/tea/raft consensus" demo.
#   1. run the REAL demo (runDemo + narrateDemo) and capture its authentic bytes
#      — every phase, leader, term, commit index, and committed log on screen
#   2. synthesize demo/raft.cast (make-raft-cast.py) — adds title/voiceover/pacing
#   3. render demo/raft.gif with agg
#
# The cast is a paced dramatization, but every number it shows is captured live
# here from the actual demo — change the engine, re-run this, the cast updates.
# Present live:  asciinema play packages/tea/demo/raft.cast
set -u
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # packages/tea/demo
PKG="$(cd "$DEMO/.." && pwd)"                            # packages/tea
CAP="${CAP:-/tmp/raft}"
mkdir -p "$CAP"

# 1 · capture the REAL demo output (the exact bytes `pnpm demo:raft` prints).
#     tsx isn't a workspace dependency, so resolve it via `pnpm dlx` (cached).
( cd "$PKG" && pnpm dlx tsx@4.21.0 -e "
import { runDemo, narrateDemo } from './src/raft/demo.ts';
process.stdout.write(narrateDemo(runDemo()));
" ) > "$CAP/narrate.txt"

lines=$(wc -l < "$CAP/narrate.txt")
[ "$lines" -gt 20 ] || { echo "capture looks empty ($lines lines) — aborting"; exit 1; }

# 2 · synthesize + 3 · render
CAP="$CAP" python3 "$DEMO/make-raft-cast.py" > "$DEMO/raft.cast"
agg --font-size 18 "$DEMO/raft.cast" "$DEMO/raft.gif" >/dev/null 2>&1

echo "· captured $lines lines of real demo output"
echo "· wrote demo/raft.cast ($(wc -c <"$DEMO/raft.cast") bytes) + demo/raft.gif ($(wc -c <"$DEMO/raft.gif") bytes)"
echo "done. preview live with:  asciinema play packages/tea/demo/raft.cast"
