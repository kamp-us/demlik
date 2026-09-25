---
"@demlik/structure-sweep": patch
---

A `git check-ignore` that exits before reading every path (`EPIPE`), or that cannot be spawned,
now throws the same `git check-ignore failed in <cwd> (<exit>): <reason>` error as any other
failed run, instead of a bare `spawnSync git EPIPE` (#405). It still fails closed.
