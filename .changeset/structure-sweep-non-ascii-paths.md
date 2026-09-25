---
"@demlik/structure-sweep": patch
---

`sweep`, `consolidate` and `move` now include files with non-ASCII names (#400).

Under git's default `core.quotePath`, a path such as `src/çay.ts` was listed as the
C-quoted `"src/\303\247ay.ts"`, so `sweep` never judged the file and `consolidate` and
`move` never saw it — with no error. Every tracked-path listing now reads git's
NUL-separated output, so these files appear under their real paths. A sweep row's
shape is unchanged.
