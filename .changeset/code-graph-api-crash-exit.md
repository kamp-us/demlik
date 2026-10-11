---
"@demlik/code-graph": patch
---

Fix: `code-graph --api` (alone, with `--api-base`, or with `--api-policy`) no longer ends a crash
with exit 1, the code the ratchet uses for a miss. Any error that is not a refused input now prints
one line, `code-graph: unexpected error: <message>`, with no stack trace, and exits 3. An `--out`
file that cannot be written is one of these. Exits 0, 1 and 2 mean what they did.

Fix: the tsgo server code-graph starts no longer prints a stray `context canceled` line on stderr
when a run ends. This applies to every mode that reads types, not only `--api`.
