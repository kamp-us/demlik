---
"@demlik/code-graph": minor
---

`readAllowance`'s `decidedBy` is now optional, so a driving adapter that only reads can be
licensed without a library import it has no reason to make. A scope's entry that leaves `decidedBy`
out licenses every listed driven file that only reads for any driving file of its own feature,
whatever else that file imports, and `--boundaries --ci` stops reporting those reads as B8. A listed
file that writes through a data binding is still B8 for every driving file that imports it,
`application/` and a file the entry does not list are still B8, and the tool does not check that the
adapter decides nothing: review holds that, as it holds an ORM write.

Omission is the only spelling of the weaker rule: `decidedBy: []` is still refused (exit 2, as an
allowance that grants nothing). A rules file that names `decidedBy` in every scope it declares, or
declares no `readAllowance`, reports, gates and writes the same bytes as before, and each scope of
one rules file is judged by its own entry.
