#!/usr/bin/env python3
"""
make-saga-cast.py — synthesize demo/saga.cast: "Saga rollback you can replay".

A story cast for `@demlik/tea/workflow`. The body is the REAL output of
`narrateDemo(runDemo())` — every committed/compensated list, status, output, and
trace line on screen is captured live by record-saga.sh (CAP/narrate.txt) from
the actual demo, never invented here. This generator only adds *direction*: a
title card, voiceover, color, and frame-exact pacing so the saga's two paths read
calmly — the forward happy path, then the forced ship failure that PIVOTS into a
strict reverse-order rollback (release inventory → refund → cancel order).

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

CAP = os.environ.get("CAP", "/tmp/saga")
W, H = 78, 32

# ── colorizers for the captured trace rows ──────────────────────────────────────
# A captured trace row carries a leading mark that classifies the step:
#   ✓ did:    place the order      → running          (a committed forward step)
#   ✗ FAILED: ship the package     → compensating     (the step that blows up)
#   ↩ undid:  release the inventory → compensating     (a reverse compensation)
#   ✗↩ FAILED to undo: ...         → ...              (a compensation that failed)
TRACE = re.compile(r"^(\s*)([✓✗↩]|✗↩)\s+(did|FAILED|undid|FAILED to undo):\s+(.*)$")


def recolor_trace(ln: str) -> str:
    m = TRACE.match(ln)
    if not m:
        return ln
    indent, mark, verb, rest = m.groups()
    # split "label → status" so we can dim the arrow + status tail.
    if "→" in rest:
        label, _, status = rest.partition("→")
        label, status = label.rstrip(), status.strip()
        tail = f" {DIM}→{RST} {DIM}{status}{RST}"
    else:
        label, tail = rest, ""
    if verb == "did":  # committed forward step
        mc, vc = GRN, GRN
    elif verb == "FAILED":  # the failing step — the dramatic beat
        mc, vc = RED + BLD, RED + BLD
    elif verb == "undid":  # a reverse-order compensation
        mc, vc = YEL + BLD, YEL
    else:  # FAILED to undo
        mc, vc = RED + BLD, RED + BLD
    return f"{indent}{mc}{mark}{RST} {vc}{verb}:{RST} {WHT}{label}{RST}{tail}"


# ── colorizers for the scenario summary fields (committed/compensated/status) ────
def recolor_field(ln: str) -> str:
    s = ln.strip()
    if ":" not in s:
        return None
    label, _, value = s.partition(":")
    value = value.strip()
    if label.startswith("committed"):
        hi = GRN + BLD
    elif label.startswith("compensated") or label.startswith("rolled back"):
        hi = (YEL + BLD) if value not in ("[—]", "[]") else DIM
    elif label.startswith("final status") or label in (
        "happy path",
        "forced failure",
    ):
        hi = GRN + BLD if "completed" in value else (RED + BLD if "failed" in value else WHT)
    elif label.startswith("reverse-order rollback"):
        hi = CYN + BLD  # the headline property — emphasize it
    elif label.startswith("output"):
        hi = WHT + BLD
    else:
        hi = WHT
    return "  " + DIM + label + ":" + RST + "  " + hi + value + RST


# ── the director's beat injected as a scenario opens (editorial framing only) ────
SCENARIO_BEAT = {
    "happy": (GRN, "  ✓ all four activities commit in order — the saga settles completed."),
    "forced": (RED, "  ✗ ship fails after three steps committed — the engine PIVOTS to rollback."),
}

# ── load the real captured narration ────────────────────────────────────────────
raw = open(CAP + "/narrate.txt").read().splitlines()

# ══ TITLE CARD ══════════════════════════════════════════════════════════════════
clearscreen()
wait(0.3)
blank(1)
line("  " + MAG + BLD + "@demlik/tea/workflow" + RST + WHT + "  —  Saga rollback you can replay" + RST)
line("  " + DIM + "─" * 48 + RST)
wait(0.7)
vo("  A Saga is a distributed transaction: each step commits, and declares the")
vo("  compensation that undoes it. No two-phase lock — you roll forward, or you")
vo("  roll back by running every committed step's undo, in strict reverse order.")
wait(0.6)
vo("  saga:  order → charge → reserve → ship.   Two scripted paths, one reducer.")
wait(1.4)

# ══ THE COMMAND ═════════════════════════════════════════════════════════════════
typed("pnpm demo:saga")
wait(0.3)

# ══ REPLAY THE REAL NARRATION, PACED ════════════════════════════════════════════
in_summary = False
saw_first_rule = False
for ln in raw:
    stripped = ln.strip()

    # the captured banner: skip the ==== rules and the title/saga header lines —
    # the title card above already framed them.
    if set(stripped) == {"="}:
        continue
    if stripped.startswith("@demlik/tea/workflow") or stripped.startswith("saga:"):
        continue

    # enter the summary block on the ---- rule.
    if set(stripped) == {"-"} and stripped:
        if not in_summary:
            in_summary = True
            blank(1)
            wait(0.6)
            line("  " + DIM + "─" * 48 + RST)
            wait(0.5)
        else:
            line("  " + DIM + "─" * 48 + RST)
            wait(1.0)
        continue

    # scenario header: "Happy path …" / "Forced failure …" (not indented, has a —).
    if not in_summary and stripped and ln == stripped and "—" in stripped:
        blank(1)
        wait(0.5)
        title_c = GRN if stripped.lower().startswith("happy") else RED
        line("  " + title_c + BLD + stripped + RST)
        wait(0.5)
        key = "happy" if stripped.lower().startswith("happy") else "forced"
        beat = SCENARIO_BEAT.get(key)
        if beat:
            emit(beat[0] + beat[1] + RST + "\r\n")
            wait(1.4)
        continue

    if not stripped:
        blank(1)
        wait(0.25)
        continue

    # the "trace:" label — a quiet sub-header before the per-step rows.
    if stripped == "trace:":
        line("  " + DIM + "trace:" + RST)
        wait(0.35)
        continue

    # trace rows (✓ did / ✗ FAILED / ↩ undid) — the heart of the story.
    tr = TRACE.match(ln)
    if tr:
        emit(recolor_trace(ln) + "\r\n")
        # linger on the failure and on each compensation so the reverse unwind reads.
        verb = tr.group(3)
        wait(0.85 if verb == "FAILED" else (0.55 if verb in ("undid", "FAILED to undo") else 0.3))
        continue

    # the "Summary" sub-header.
    if stripped == "Summary":
        line("  " + WHT + BLD + "Summary" + RST)
        wait(0.4)
        continue

    # committed/compensated/status/output fields (in scenarios AND summary).
    fr = recolor_field(ln)
    if fr is not None:
        emit(fr + "\r\n")
        # let the reverse-order headline land with extra weight.
        wait(1.1 if stripped.startswith("reverse-order rollback") else 0.5)
        continue

    # anything else → voiceover grey.
    vo("  " + stripped, hold=1.2)

# ══ CLOSE ═══════════════════════════════════════════════════════════════════════
blank(1)
wait(0.8)
vo("  The rollback ran the compensations in strict reverse of the commit order —")
vo("  release inventory → refund → cancel order.  That's the Saga guarantee.")
vo("  Every byte above is real demo output — only the pacing is staged.")
wait(2.2)

write_cast(events, W, H)
