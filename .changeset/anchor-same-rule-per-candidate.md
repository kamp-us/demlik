---
"@demlik/structure-sweep": patch
---

`pairs` anchor mode asks one yes/no `same_rule` question per candidate instead of one single-choice
question per anchor, so an anchor with two or more true duplicates confirms every one of them and
`pairs.md` groups the whole family. Before, the duplicates split one choice's probability, so each
could fall below a confidence floor and none was confirmed.

Each anchor is still asked in one request. An anchor with more candidates than one request's
question cap (32, beside `business_rule`) is asked in one request per chunk, and `pairs --plan`
counts every chunk as a Jev call.

The pairs cache key now carries the anchor question version, bumped to 2, so no row asked under the
old single-choice question is served as a cache hit: the first anchor-mode run after upgrading asks
Jev again. Pairwise rows are unaffected. `anchorQuestions` now takes the candidate refs rather than
a count, and `AnchorAnswers.partner` records `version` in place of `chosen`.
