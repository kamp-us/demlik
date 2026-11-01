---
"@demlik/code-graph": patch
---

A file's `loc` no longer counts the empty line after its final newline, so it matches `wc -l` and an editor. A file of exactly 400 lines now reads as 400, with no `big-file` smell at the default limit, where it used to read as 401. The same number feeds `totalLoc`, the tree and HTML reports, and the comment census's `loc` and `blankLines`. A file's `codeLines` and `ratio` do not change, so no recorded comment ceiling moves, and line numbers in findings stay where they were.

**Recorded `big-file` values drop by one on the next `--ci`.** An entry is lowered to the new number and an entry recorded at 401 for a 400-line file is pruned. Neither fails the run, but a repo that also fails CI on an uncommitted ledger needs to commit that one rewrite.
