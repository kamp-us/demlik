---
"@demlik/tea": minor
---

**Breaking:** tea no longer does dependency injection (ADR 0020). The provider
graph and the `R` (requirements) channel on Cmds are removed.

Removed from `@demlik/tea`:

- The provider graph: `provide`, `layer`, `value`, `dep`, `isProvided`,
  `Provided`, `ProvidedCtx`, `Provider`, `Scope`, `OnReleaseError`, `DepToken`,
  `DepsOf`, `ProvideFailedError`, `UnknownProviderError` and
  `ProviderCycleError`.
- The `"provide"` runtime error phase and `RuntimeErrorContext.provider`.
- `Cmd.requirements`, `Requirements`, `RequirementsOf` and `RequiredCtx`, and
  `Cmd.define`'s `requirements` field.
- `ScopedCtxArg`. `run`'s `ctx` is a plain object only.

A Cmd type is now `Cmd<Type, Ok, E>`: the tag, the value it settles with, and
the `_tag` union it can fail with. `CmdValue` and `CmdDef` lose their `R`
parameter too; `CmdValue` gains `Ok` in its place.

Migrate:

```ts
// before
const fetch = Cmd.define("fetch", {
  input, ok, err: ["not_found"],
  requirements: Cmd.requirements<{ http: Http }>(),
});
defineMachine({ types: { model, msg }, cmds: [fetch], … });
run(machine, { ctx: provide({ http: layer(openHttp, closeHttp) }) });

// after — name the ctx on the machine and hand `run` the object
const fetch = Cmd.define("fetch", { input, ok, err: ["not_found"] });
defineMachine({ types: { model, msg, ctx: {} as { http: Http } }, cmds: [fetch], … });
const http = await openHttp();
try {
  const rt = await run(machine, { ctx: { http } }).ready;
  // …
} finally {
  await closeHttp(http);
}
```

`@demlik/tea/agent` (experimental): `tool()` no longer takes `requirements`.
Annotate the handler's `ctx` parameter instead — `async (args, ctx: { kb: Kb },
{ ok, fail }) => …` — and `defineAgent` / `toMachine({ tools })` still demand
that ctx at `run`. `ToolsCtx<T>` names the ctx a tool set reads.

The how-to "Scope a resource across a run" is removed with the API it taught.
