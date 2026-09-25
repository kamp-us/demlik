---
"@demlik/structure-sweep": minor
---

`structure-sweep score` grades a sweep's feature vocabulary against git history
(#383): co-change precision, recall and F1 overall and per feature, the
leaf-folder baseline, and the share of confidently labelled rows. The library
exports it as `scoreCoChange`, a pure function over verdict rows and change
sets, with `readChangeSets` as its history reader.
