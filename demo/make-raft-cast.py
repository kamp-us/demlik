#!/usr/bin/env python3
"""
make-raft-cast.py — synthesize demo/raft.cast: "consensus you can replay".

A story cast for `@demlik/tea/raft`. The body is the REAL output of
`narrateDemo(runDemo())` — every phase headline, leader, term, commit index, and
committed log on screen is captured live by record-raft.sh (CAP/narrate.txt) from
the actual demo, never invented here. This generator only adds *direction*: a
title card, voiceover, color, and frame-exact pacing so the deterministic
failover arc reads calmly — elect → commit → KILL the leader → re-elect → the
survivors' logs converge.

Why synthesize vs `asciinema rec`: a headless shell has no TTY, so a recorder
doesn't honor real `sleep` timing and the GIF races by. Output: a v2 cast on
stdout (see castkit.write_cast).
"""
import os
import re

from castkit import (
    BLD,
    CYN,
    DIM,
    GRN,
    MAG,
    NUM,
    RED,
    RST,
    WHT,
    YEL,
    blank,
    clearscreen,
    emit,
    events,
    line,
    typed,
    vo,
    wait,
    write_cast,
)

CAP = os.environ.get("CAP", "/tmp/raft")
W, H = 78, 30

# ── colorizers for the captured node rows ───────────────────────────────────────
ROLE_COLOR = {"leader": GRN, "candidate": YEL, "follower": WHT}
# A captured node row:  "    n0  leader    term=1 commit=1 committed=[42]"
ROW = re.compile(
    r"^(\s*)(n\d+)\s+(leader|candidate|follower)\s+"
    r"term=(\d+)\s+commit=(\d+)\s+committed=(\[[^\]]*\])\s*$"
)


def recolor_row(ln: str) -> str:
    m = ROW.match(ln)
    if not m:
        return ln
    indent, node, role, term, commit, log = m.groups()
    rc = ROLE_COLOR.get(role, WHT)
    marker = GRN + "▸" + RST if role == "leader" else " "
    has_log = log != "[]"
    log_c = (YEL + BLD if has_log else DIM) + log + RST
    return (
        f"{indent}{marker} {WHT}{BLD}{node}{RST}  "
        f"{rc}{role.ljust(10)}{RST}"
        f"{DIM}term={RST}{NUM}{term}{RST} "
        f"{DIM}commit={RST}{NUM}{commit}{RST} "
        f"{DIM}committed={RST}{log_c}"
    )


def recolor_misc(ln: str) -> str:
    s = ln.strip()
    if s.startswith("leader:"):
        who = s.split(":", 1)[1].strip()
        return "  " + DIM + "leader: " + RST + GRN + BLD + who + RST
    if s.startswith("cluster:"):
        return "  " + DIM + s + RST
    return None


# ── the director's beat injected as a phase opens (editorial framing only) ───────
PHASE_BEAT = {
    3: (RED, "  ✗ the leader goes dark — every message to and from it is dropped."),
    4: (CYN, "  ↑ a survivor times out and wins a HIGHER term — that's the safety rule."),
    5: (GRN, "  ✓ the new leader commits on the surviving majority; the logs converge."),
}

# ── load the real captured narration ────────────────────────────────────────────
raw = open(CAP + "/narrate.txt").read().splitlines()

# Split off the library's own banner (the leading ==== title block) — we draw our
# own title card — and the trailing Summary block; keep the 5 phase blocks.
PHASE = re.compile(r"^(\d+)\.\s+(.*)$")

# ══ TITLE CARD ══════════════════════════════════════════════════════════════════
clearscreen()
wait(0.3)
blank(1)
line("  " + MAG + BLD + "@demlik/tea/raft" + RST + WHT + "  —  consensus you can replay" + RST)
line("  " + DIM + "─" * 44 + RST)
wait(0.7)
vo("  Raft keeps a cluster agreeing on one log, even when a node dies.")
vo("  This whole run is a deterministic replay — same trace, same bytes, every time.")
wait(0.6)
vo("  Watch five moves: elect · commit · kill the leader · re-elect · converge.")
wait(1.4)

# ══ THE COMMAND ═════════════════════════════════════════════════════════════════
typed("pnpm demo:raft")
wait(0.3)

# ══ REPLAY THE REAL NARRATION, PACED ════════════════════════════════════════════
in_summary = False
phase_no = 0
for ln in raw:
    stripped = ln.strip()

    # skip the captured banner's ==== rules and its own title/cluster header —
    # the title card above already framed it.
    if set(stripped) == {"="}:
        continue
    if stripped.startswith("@demlik/tea/raft") or stripped.startswith("cluster:"):
        continue

    # enter the summary block on the ---- rule.
    if set(stripped) == {"-"} and stripped:
        if not in_summary:
            in_summary = True
            blank(1)
            wait(0.6)
            line("  " + DIM + "─" * 44 + RST)
            wait(0.5)
        else:
            line("  " + DIM + "─" * 44 + RST)
            wait(1.0)
        continue

    # phase header: "N. Title"
    pm = PHASE.match(stripped)
    if pm and not in_summary:
        phase_no = int(pm.group(1))
        blank(1)
        wait(0.5)
        line("  " + NUM + BLD + pm.group(1) + "." + RST + " " + CYN + BLD + pm.group(2) + RST)
        wait(0.5)
        beat = PHASE_BEAT.get(phase_no)
        if beat:
            emit(beat[0] + beat[1] + RST + "\r\n")
            wait(1.4)
        continue

    if not stripped:
        blank(1)
        wait(0.25)
        continue

    # node rows.
    rr = ROW.match(ln)
    if rr:
        emit(recolor_row(ln) + "\r\n")
        wait(0.32)
        continue

    # leader:/cluster: lines.
    mc = recolor_misc(ln)
    if mc is not None:
        emit(mc + "\r\n")
        wait(0.4)
        continue

    # summary "label: value" lines.
    if in_summary:
        if stripped == "Summary":
            line("  " + WHT + BLD + "Summary" + RST)
            wait(0.4)
            continue
        if ":" in stripped:
            label, _, value = stripped.partition(":")
            hi = YEL + BLD if ("[" in value or "OK" in value) else WHT
            line("  " + DIM + label + ":" + RST + " " + hi + value.strip() + RST)
            wait(0.55)
            continue

    # the plain-language phase note → voiceover grey.
    vo("  " + stripped, hold=1.3)

# ══ CLOSE ═══════════════════════════════════════════════════════════════════════
blank(1)
wait(0.8)
vo("  Every byte above is real demo output — only the pacing is staged.")
vo("  Want the per-step detail?  " + WHT + "pnpm demo:raft:viz" + DIM + "  renders all 35 steps.")
wait(2.6)

write_cast(events, W, H)
