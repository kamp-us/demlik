---
"@demlik/tea": minor
---

`tool()` takes a required `description` — the model-facing sentence a provider adapter declares
to the model beside the schema (Anthropic `description`, OpenAI `function.description`) — and
surfaces it as `description: string` on `ToolDef` / `AnyToolDef` (experimental tier, #91). An
adapter reads `t.description`, never a `.describe()` off the `input` schema: that one describes
the arguments object and lands inside the emitted JSON schema, a different field on every wire
format.
