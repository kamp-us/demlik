---
"@demlik/tea": minor
---

`defineAgent(cfg)` grows `.with({ interpret })`, so one unusual requirement costs one
interpret cell instead of a rebuild under `createAgent`.

The gap it closes is the ramp: three intents on one side, fourteen fields on the other, and
nothing in between. `.with` wraps a NAMED cell of the machine the lid already built and
returns another defined agent — `run`, `machine`, `with` again — so the agent it was called
on is unchanged and every cell the overlay does not name is carried over by reference.

```ts
const queued = defineAgent({ model, tools: [fetchRate], instructions }).with({
  interpret: {
    fetch_rate: (next) => async (cmd, ctx, dispatch) =>
      inTurn(() => next(cmd, ctx, dispatch)),
  },
});
```

The wrapped cell settles through the SAME typed Cmd→Msg edge as the cell it wraps: `next`
resolves the `Cmd.define`d `<tool>_ok` / `<tool>_err` Msg carrying the call's own `callId`,
and returning it unchanged is what keeps the fold — and a replay of the wrapped run —
identical to the unwrapped run's. That is the door's whole contract: it is one over the
effect boundary, never over the fold. A cell that must settle differently is a different
machine, and `createAgent` is still where you build one.

`with` composes, later call outermost (`a.with(x).with(y)` enters `y` first). Naming a cell
the machine has none of throws at `machine(input)` — where the table to check the name
against exists — listing the cells it does have.

Additive: an agent that never calls `with` builds the same machine, from the same cells, as
before. New types beside it: `DefinedAgentMsg`, `DefinedAgentCmd`, `DefinedAgentInterpret`,
`InterpretOverlay`, `DefinedAgentOverlay`.
