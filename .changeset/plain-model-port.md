---
"@demlik/tea": minor
---

`createAgent` and `createLlmCall` take a plain function as the model.

`model: async (messages) => turn` is now the common path where the
`(modelId) => Llm` factory was required. The returned turn is validated
through the purpose's schema (`agentTurnSchema` for the plain agent case),
so a malformed answer surfaces as the run's `llm` failure exactly as a
structured-output mismatch does — data on the settle Msg, never a throw
out of the handler. The factory, and `withStructuredOutput(schema)` on it,
stays the advanced form for a model that binds the schema itself.

A bare `async` function is read as the plain port by its `AsyncFunction`
tag; a sync function that returns a promise (`(m) => client.chat(m)`) goes
through the exported `plainModel(fn)` to lift it into the factory shape.
Passed bare, such a function is refused on its first call with an `LlmErr`
whose `reason` is `PLAIN_MODEL_MISROUTE_REASON` — it names `plainModel(fn)`
as the fix, and never reaches `withStructuredOutput`. `ModelPort` names the
union, `PlainModel` the plain member. All under `./agent` and `./llm-call`,
experimental tier.
