---
"@demlik/tea": minor
---

`Cmd.define`'s `R` channel is declared with `requires`, not `needs` — one word per concept, and
it is Effect's ("Requirements"). `deps` keeps its own meaning on `layer`: the edges between
providers in the host-side graph. No alias — the field never shipped (ADR 0014 amendment #189).

Migration: rename `needs` → `requires`, `Cmd.needs<R>()` → `Cmd.requires<R>()`, and
`NeedsOf<C>` → `RequiresOf<C>`. `RequiredCtx<C>` is unchanged.
