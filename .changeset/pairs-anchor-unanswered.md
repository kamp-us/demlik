---
"@demlik/structure-sweep": patch
---

An anchor-mode `pairs` row whose candidate ref Jev's answer gives no probability is now
**`unanswered`**, not a verdict. Before, a missing ref read as probability 0, so the row recorded
`look_alike` at confidence 1 (or `same_decision` at 0 when Jev picked that ref), and the cache served
that made-up answer on every later run. Now the row's verdict is `{ "choice": "unanswered" }`, with
no confidence, and its `partner` has no `probability`. It is never served from `pairs.json` as an
answer, so the next run asks that anchor's menu again. `pairs.md` and the stderr summary count it
on an `unanswered` line, shown only when a row is unanswered, and no `pairs.md` group, `consolidate`
proposal or `inventory` lever reads it as a verdict.

For library callers, `AnchorAnswers` is now a union with the `unanswered` variant, `countVerdicts`
and `actionFor` take the new `RowVerdict` (`PairVerdict` or `unanswered`), and the index exports
`UNANSWERED`, `RowVerdict` and `isAnswered`.

The `pairs.json` row fields are now listed in the README, including the optional `lowered` field:
a hash of the lowered bodies sent, present on a row asked under `--graph` where at least one side
went out lowered, and part of the row's cache key.
