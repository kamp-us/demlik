---
"@demlik/code-graph": patch
---

The API ledger no longer loses recorded reasons when the tree does not compile. On a run whose emit reported diagnostics, `--api <map> --ci` and `--api <map> --accept-api` prune nothing: every entry the view does not list stays, each is printed with a note that the compiler reported errors, and `--json` lists them under a new `unmeasured` key beside an empty `pruned`. New names still fail and can still be accepted, and a blank name from a syntax error is neither listed nor recorded, so `--accept-api` on such a tree can no longer write a ledger the next run refuses to read. A type error anywhere in the tsconfig holds back a real removal too; the entry prunes on the first clean run.
