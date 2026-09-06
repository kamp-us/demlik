---
"@demlik/tea": minor
---

Typed effect channels on Cmd constructors (ADR 0014). Additive kernel types — every existing
`Cmd<A>`, battery Cmd union and machine compiles unchanged.

- `Cmd<T, E, R>` — `E` (the `_tag` union a Cmd can settle with) and `R` (the `Ctx` slice its
  handler needs) ride as phantom type parameters; the runtime value stays `{ type }`.
- `Cmd.define(name, { input, ok, err, needs })` — the typed constructor. Returns the Cmd builder
  (`fetch({ url })` → `{ type: "fetch", url }`) carrying `ok(cmd, value)` / `err(cmd, error)`
  Msg builders and the declaration; `Settled<typeof fetch>` is its `fetch_ok` / `fetch_err`
  Msg union. `Cmd.needs<R>()` names the `R` slice. `input` / `ok` are zod schemas — `zod` is
  now a runtime dependency.
- `defineMachine({ cmds: [fetch], … })` derives the machine's Cmd union and the settled half of
  its `M` from the constructors; the reducer must carry the `_ok` / `_err` cells without the
  user naming them in `Msg`.
- `run` types `ctx` as `Ctx & RequiredCtx<C>` — a ctx missing a key any Cmd's `R` names is a
  compile error. `useMachine`, `agentHost` and the chart inspector thread the same demand. An
  `Interpret` cell's `ctx` carries its own Cmd's `R`.
- Boundary enforcement: a handler's `_ok` value is parsed against the `ok` schema at the
  interpret edge; a value that fails becomes the minted `_err` carrying
  `{ _tag: "malformed_result", issues }` and never reaches Model. The parsed (stripped) value
  is what lands. `run({ clock })` stamps `at` on every settled Msg (default `Date.now`).
- `settle(def, work)` — `tryInterpret`'s successor for a typed Cmd: `work` returns
  `Result<Ok, E>` with both channels inferred from the def; the helper maps the arms onto the
  minted Msgs. `Interpret` keeps returning `Promise<M | void>`.
