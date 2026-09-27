---
"@demlik/structure-sweep": minor
---

This is a minor bump because it changes exported shapes:

- `anchorQuestions(count)` is now `anchorQuestions(refs)`: it takes the candidate refs, not a count.
- `AnchorAnswers.partner` drops `chosen` and records `version` instead.
- `HelperPairRow` is renamed `JudgedPairRow`; `HelperPairRow` stays as a deprecated alias.
- `ConsolidationPlan` gains the required fields `floor` and `collapse`.

`pairs` anchor mode asks one yes/no `same_rule` question per candidate instead of one single-choice
question per anchor, so an anchor with two or more true duplicates confirms every one of them and
`pairs.md` groups the whole family. Before, the duplicates split one choice's probability, so each
could fall below a confidence floor and none was confirmed.

Each anchor is still asked in one request. An anchor with more candidates than one request's
question cap holds beside `business_rule` is asked in one request per chunk, and `pairs --plan`
counts every chunk as a Jev call. The cap defaults to `JEV_MAX_QUESTIONS` (32), now exported; a
caller names another with `pairs --max-questions <n>` or the `maxQuestions` option on `runPairs` /
`planPairs`, validated by the exported `maxQuestions`.

The pairs cache key now carries the anchor question version, bumped to 2, and the candidate's ref,
so no row asked under the old single-choice question is served as a cache hit: the first
anchor-mode run after upgrading asks Jev again. Pairwise rows are unaffected. `anchorQuestions` now
takes the candidate refs rather than a count, and `AnchorAnswers.partner` records `version` in place
of `chosen`.

`pairs` keeps one row per scope and pair of functions. A row's `id` hashes the two bodies, and rows
were stored under it, so byte-identical copies of a function (and the same bodies in two scopes of
one run) kept only one row between them and dropped the rest of their family.

`consolidate` now proposes **collapse** groups: `same_decision` pairs at or above `--floor`
(default 0.8, `DEFAULT_COLLAPSE_FLOOR`), joined wherever two pairs share a function within a scope,
whichever anchor asked each pair. So `pairs` then `consolidate` over three copies of one rule and a
look-alike proposes the three copies as one group. `consolidate.json` gains `floor` and `collapse`
(`null` when there is no pairs file), `consolidate.md` a "Collapse copies of one rule" section, and
the library `collapseProposals`. `HelperPairRow` is renamed `JudgedPairRow`, kept as a deprecated
alias, and now reads each answered verdict's `confidence`.
