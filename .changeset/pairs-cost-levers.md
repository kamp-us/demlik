---
"@demlik/structure-sweep": minor
---

`structure-sweep pairs` now asks in **anchor mode by default**. Each collapse pair is dealt to one of
its two functions, the anchor, and Jev is asked once per anchor, which of its candidate partners
encodes the same business rule, or `none`. The anchor's body is sent once rather than once per
pair. `pairs.json` keeps one row per pair with the same fields: the picked candidate is
`same_decision` at its ref's probability, and every other candidate is `look_alike`. Anchor mode
never records `shared_helper`. The old per-pair question stays behind `--pairwise`, for gold-set
evaluation.

The cache key now includes the mode, so the new default does not reuse cached pair rows written by
earlier versions: the first anchor-mode run over an existing `pairs.json` asks Jev again. A
`--pairwise` run still reuses them.

`--plan` prints the candidate pairs, anchors, distinct functions and an estimate of the input
tokens for the selected mode, then exits without calling Jev or reading `TYPESAFE_API_KEY`.
`--max-partners <n>` (default 10) judges each anchor against at most its `n` best partners by graph
confidence and lists every skipped pair in `pairs.md`. `--graph <graph.json>` sends each function's
stage-2 lowered body instead of its source, in either mode, and lowered and raw sends never share a
cached answer.
