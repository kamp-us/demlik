---
"@demlik/structure-sweep": minor
---

`structure-sweep pairs` can now price a run before spending it and spends less on a large one.
`--plan` prints the candidate pairs, the distinct functions and an estimate of the input tokens, then
exits without calling Jev or reading `TYPESAFE_API_KEY`. `--max-partners <n>` (default 10) judges
each function against at most its `n` best partners by graph confidence and lists every skipped
pair in `pairs.md`. `--graph <graph.json>` sends each function's stage-2 lowered body instead of its
source, and lowered and raw sends never share a cached answer. A run with no pair over the cap and
no `--graph` writes the same `pairs.json` and `pairs.md` as before.
