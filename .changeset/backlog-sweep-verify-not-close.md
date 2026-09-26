---
"@demlik/backlog-sweep": minor
---

A `close` is proposed only on a fact the tool computed, never on Jev's word alone (#388).

- **`already_done` proposes `verify`.** It carries every linked pull request with its state and
  relation, and the commits that reference the issue. It becomes a `close` only beside a merged
  pull request that closes the issue, and the proposal names that pull request as its `basis`.
- **Linked pull requests say whether they close the issue.** Each carries `relation: "closes" |
  "partial"`, read from GitHub's closing references and the closing keywords in its body, and a
  state of `open`, `merged` or `closed-unmerged`.
- **`obsolete` closes only on a computed fact.** The evidence gains `allMentionedPathsGone` and
  `linkedPullRequestClosedUnmerged`, and an `obsolete` answer with neither true proposes `review`.
- **`backlog-sweep duplicates`** groups open issues Jev confirms are the same defect, from TF-IDF
  candidate pairs, into `.backlog-sweep/duplicates.json`. It closes and labels nothing.
- A resumed run recomputes each cached answer's evidence and proposal.
