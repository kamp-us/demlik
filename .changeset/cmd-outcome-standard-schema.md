---
"@demlik/tea": minor
---

**Breaking:** a `Cmd.define`d handler returns an outcome, and the engine mints
the Msg (ADR 0021). `Cmd.define` takes any Standard Schema.

A handler gets `ok` / `err` builders on its ctx and returns what they build.
The engine turns it into `<name>_ok` or `<name>_err`:

```ts
// before
fetch: settle(fetch, async (cmd, ctx) => Result.ok(await ctx.http.get(cmd.url)))
// after
fetch: async (cmd, { http, ok, err }) =>
  res.status === 404 ? err({ _tag: "not_found" }) : ok(await http.get(cmd.url))
```

- New in `@demlik/tea`: `Outcome` (the `{ _tag: "Ok", value } | { _tag: "Err", error }`
  record, with `Outcome.ok` / `Outcome.err`), `OutcomeHelpers`, `InterpretCell`,
  `OkOfCmd`, `DeclaredErrorsOf`, and three thrown errors: `UndeclaredFailureError`,
  `OutcomeContractError` and `AsyncSchemaError`.
- A throw, an `err` whose tag the def does not declare, or a handler returning
  any Msg goes to `onError` under the new `"interpret"` phase. No `_err` Msg is
  dispatched, and the dispatch still resolves. A defined handler returns an
  outcome or nothing: it can no longer answer with a follow-up Msg.
- `Cmd.define`'s `input` / `ok` take any Standard Schema whose `validate` is
  synchronous: zod as it is, Effect Schema through `Schema.toStandardSchemaV1`.
  `MalformedResult` issues now come from the schema's Standard Schema issues.
- Removed: `settle`. `tryApplyCell` and `tryFoldMsgs` return an `Outcome`
  instead of a `better-result` `Result` — read `r._tag === "Ok"` and
  `r.value` / `r.error`.
- Dependencies: `better-result` and `zod` are gone. The one runtime dependency
  is `@standard-schema/spec` (types only). Install zod yourself if you use it.
- `@demlik/tea/agent`: a `tool()` handler's `ok` / `fail` build an `Outcome`,
  a tool's `input` / `ok` take a Standard Schema, and `ToolDef.interpret`
  returns the outcome rather than the settled Msg.
- Plain Cmds are unchanged: their handler still returns a Msg or nothing.
