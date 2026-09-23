---
"@demlik/tea": minor
---

**Breaking (`@demlik/tea/resilience`, `battery` tier):** resilient-call's
`succeed` and `fail` verbs are replaced by one `settle(slice, msg)`.

`createResilientCall(...)` no longer returns `succeed` or `fail`. Its new
`settle` takes the knob's `_ok` or `_err` Msg, reads the key off `msg.key`, and
returns `{ call, cmds, outcome }`:

- `call` — the settled slice.
- `cmds` — the Cmds the settle emitted.
- `outcome` — `{ kind: "done", value }`, `{ kind: "failed", error }` or
  `{ kind: "retrying" }`.

The port's value is only reachable through `outcome`, so a hand-wired settle
cell can no longer fold the result into its Model before the slice has settled —
the order that left a call stuck at `running`.

Migrate each settle cell:

```ts
// before
resilient_ok: (s, m) => {
  const [call, cmds] = rc.succeed(s.call, m.key, m);
  return [{ ...s, call, user: m.result }, cmds];
},
resilient_err: (s, m) => {
  const [call, cmds] = rc.fail(s.call, m.key, m);
  return [{ ...s, call }, cmds];
},

// after — both cells route through one helper you write
resilient_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
resilient_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
```

`SettleOutcome` and `SettleResult` are exported for typing that helper. The new
how-to, `docs/how-to/hand-wire-a-resilient-call.md`, shows the whole machine.

Unchanged: `settleFailed`, and the `succeed` / `fail` verbs of the knobs built on
resilient-call (`createJevAsk`, `createLlmCall`, `createAuthedCall`), which now
settle through `settle` inside. `mountResilientCall` still takes a knob with
`succeed` / `fail`, so mounting a bare resilient-call knob now means binding both
to `settle` yourself.
