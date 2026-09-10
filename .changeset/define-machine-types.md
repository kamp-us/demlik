---
"@demlik/tea": minor
---

`defineMachine` names Model and Msg once, as values, under a new `types` option — no type
arguments, no hand-spelled `Settled<typeof cmd>` union, no separate `Reducer<…>` annotation.

```ts
const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg },
  cmds: [lookup, audit],
  init: (loaded) => [loaded ?? initial, []],
  update: {
    go: (m, msg) => …,
    lookup_ok: (m, msg) => …, // settled cells inferred from `cmds`
    …
  },
  interpret: { lookup: settle(lookup, async (cmd, ctx) => …) },
});
```

`S` and `M` come from `types`; `C` and the settled half of `M` from `cmds`; each interpret
handler's `ctx` from its own Cmd's `requirements`. `run(machine, { ctx })` demands exactly what
it demanded before.

**Migration.** The five-slot explicit-generic form still compiles and is not deprecated in this
release, so nothing breaks. To move a call site:

```diff
-defineMachine<Model, Msg, typeof lookup, never, NoCtx>({
+defineMachine({
+  types: { model: {} as Model, msg: {} as Msg, ctx: {} as NoCtx },
   cmds: [lookup],
```

`cmd` and `sub` under `types` carry a hand-written Cmd / Sub union — the slots `cmds` and
`subscriptions` cannot imply. Drop the slot entirely where the old call passed `never`.

One shape needs a nudge: a **zero-parameter** function returning a fresh discriminated literal
(`init: () => [{ type: "idle" }, []]`, `interpret: { x: async () => ({ type: "done" }) }`) is
checked before the type parameters are fixed, so `"idle"` widens to `string`. Name the parameter
you are ignoring — `init: (_loaded) => …` — and it narrows again.

`Settled`, `Reducer`, `Transitions` and `NoCtx` stay exported for a reducer split into its own
file.
