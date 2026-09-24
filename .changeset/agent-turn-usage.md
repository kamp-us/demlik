---
"@demlik/tea": minor
---

`./agent` carries provider-reported token usage (#332). A model turn may return
`usage: TurnUsage` (`inputTokens`, `outputTokens`, and optionally
`reasoningTokens` and `cachedInputTokens`). `agentTurnSchema` rejects a malformed
report. The conversation keeps a running total in `conversation.usage`, which
survives compaction folds, stage advances and a kill/resume. It also keeps the
last turn's size in `conversation.contextTokens`. `defineAgent`'s `compaction`
gains `afterContextTokens`, which folds on that size. It works alone or beside
`afterTurns`, so `afterTurns` is now optional, but a budget must name at least
one of the two. A `stopWhen` over `conversation.usage` is a token budget.
`TurnSettled` carries the turn's `usage`. A Model persisted by 0.17.x resumes
with its total starting from zero.
