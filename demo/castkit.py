#!/usr/bin/env python3
"""
castkit.py — shared machinery for the demo cast generators.

Every make-*-cast.py script synthesizes an asciinema v2 cast by appending timed
events to a buffer, then dumping them. That buffer, the timing primitives, the
colour palette, and the final header+dump boilerplate are identical across the
generators and live here. Per-file STORY content, file-specific helpers
(banner/step/part, the c_* colorizers), and W/H constants stay in each script.

Usage in a generator:

    from castkit import *
    W, H = 92, 32
    ...                       # build the cast with line/blank/vo/clearscreen/...
    write_cast(events, W, H)  # final dump

The helpers mutate THIS module's `events`/`t`; `write_cast` reads the same
buffer that `from castkit import *` re-exports, so there's a single shared state.
Scripts whose `line`/`vo`/`typed`/`raw`/`block` differ just redefine them after
the import — their override still calls castkit's `emit`/`wait`, so it appends to
the same buffer.
"""
import json, sys, os

# ── palette (superset; a file imports whatever it uses) ─────────────────────────
RST = "\x1b[0m"
BLD = "\x1b[1m"
DIM = "\x1b[38;5;245m"        # voiceover grey
WHT = "\x1b[38;5;252m"
GRN = "\x1b[38;5;36m"         # prompt / pass
RED = "\x1b[38;5;203m"        # block / critical
CYN = "\x1b[38;5;44m"         # the differentiator line
YEL = "\x1b[38;5;221m"        # corpus weight
MAG = "\x1b[38;5;176m"        # rule names
BLU = "\x1b[38;5;75m"         # code accents
NUM = "\x1b[38;5;213m"        # step / part numerals
KEY = "\x1b[38;5;81m"         # json keys
STR = "\x1b[38;5;150m"        # json strings
# note: ORG diverges per file (oss 209, agent 215) — define it in those scripts.

# ── event buffer + timing ───────────────────────────────────────────────────────
events = []
t = 0.0

def emit(s): events.append([round(t, 3), "o", s])
def wait(dt):
    global t; t += dt
def line(s="", dt=0.0):
    emit(s + "\r\n"); wait(dt) if dt else None
def blank(n=1, dt=0.0):
    emit("\r\n" * n); wait(dt) if dt else None
def vo(s, hold=1.6):
    emit(DIM + s + RST + "\r\n"); wait(max(hold, 0.043 * len(s)))
def clearscreen(): emit("\x1b[2J\x1b[H")

def typed(cmd, dt=0.032, pre=0.4, post=0.7, prompt="❯ "):
    wait(pre); emit(GRN + prompt + RST)
    for i, ch in enumerate(cmd):
        emit(ch); wait(dt + (0.03 if ch == " " else 0.0) + (0.012 if i % 7 == 3 else 0.0))
    emit("\r\n"); wait(post)

def raw(path, indent="  ", dt=0.05, recolor=None):
    """print authentic captured bytes; optional per-line recolor(line)->line."""
    for ln in open(path).read().splitlines():
        emit(indent + (recolor(ln) if recolor else ln) + "\r\n"); wait(dt)

def block(lines, indent="  ", dt=0.05, color=None):
    for ln in lines:
        emit(indent + (color + ln + RST if color else ln) + "\r\n"); wait(dt)

# ── final cast dump ─────────────────────────────────────────────────────────────
def write_cast(events, width, height):
    hdr = {"version": 2, "width": width, "height": height,
           "env": {"TERM": "xterm-256color", "SHELL": "/bin/zsh"}}
    sys.stdout.write(json.dumps(hdr) + "\n")
    for e in events:
        sys.stdout.write(json.dumps(e, ensure_ascii=False) + "\n")
