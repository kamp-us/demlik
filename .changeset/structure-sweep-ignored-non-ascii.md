---
"@demlik/structure-sweep": patch
---

Collapse-pair candidates now exclude ignored files with non-ASCII names (#402).

Under git's default `core.quotePath`, `git check-ignore` answered an ignored path such as
`dist/çay.ts` as the C-quoted `"dist/\303\247ay.ts"`, so the file was never recognised as
ignored and its pairs reached Jev — with no error. The ignore check now reads git's
NUL-separated output, and a failed check throws instead of reading as "nothing ignored".
