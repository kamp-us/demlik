---
"@demlik/tea": minor
---

A second, optional model port shape on `@demlik/tea/agent` —
`async (messages, { onChunk }) => turn`. `defineAgent` takes one `model` field for
both shapes and tells them apart by arity (`isStreamingModel`), so a plain
`async (messages) => turn` brain is still invoked with exactly one argument and
nothing about an existing agent moves. New vocabulary: `TurnChunk`,
`ModelStream`, `StreamingModel`, `DefinedAgentModel`, `isStreamingModel`.

The deltas leave through a new `onChunk` run option, contained the way `onEvent`
is — a throwing listener is warned about, never allowed to reject the model call
it fired from.

Streaming is a side channel, never state. A chunk is not journaled, not written
to the `Store` and never folded into the Model, so the turn a streamed run
settles is identical to the one a plain model would have settled, a replay
reproduces that Model with no chunk in the journal, and a resume re-emits no
delta of a turn that already settled.
