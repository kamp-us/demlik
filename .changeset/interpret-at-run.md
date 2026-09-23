---
"@demlik/tea": minor
---

**Breaking:** a machine carries no Cmd handlers. `interpret` leaves `Machine`
and moves to where the machine runs (#251 R1.1), so one machine file runs
under whatever handlers the host hands it.

```ts
// before
const machine = defineMachine({ types, init, update, interpret });
run(machine, { ctx });

// after
const machine = defineMachine({ types, init, update });
run(machine, { ctx, interpret });
```

- `Machine` has no `interpret` field. Passing one to `defineMachine` is a type
  error, and `run` ignores one left on a machine object.
- `run` (`@demlik/tea/promise`) takes `interpret` in its options. It is
  required once the machine emits a Cmd, optional for a cmdless one, and each
  handler is checked against the machine's own Msg and Cmd unions.
- `run` also takes optional `subscribe` runners. An entry replaces the
  machine's own runner of the same Sub type, so a test can swap one runner
  without redefining the machine. `subscribe` and `subscriptions` stay on
  `Machine` for now.
- New in `@demlik/tea`: `InterpretArg<M, C, Ctx>` (the conditionally required
  `interpret` option) and `RunHandlers<M, C, U, Ctx>` (`interpret` plus
  `subscribe`).
- `@demlik/tea/react`: `useMachine(machine, { ctx, interpret, subscribe?,
  store? })`. The hook reads the latest render's handlers per call, so an
  inline handler table never reboots the runtime. `UseMachineOpts` is now
  `UseMachineOpts<S, M, C, U, Ctx>`.
- `@demlik/tea/do`: `createAgentHost`'s `buildMachine` returns
  `{ machine, interpret }`.
- `@demlik/tea/flow`: `runToTerminal`'s seed takes `interpret` beside `ctx`
  and `msgs`.
- `@demlik/tea/resilience` (battery): `withResilience`, `withDeadline` and
  `withTelemetry` take `{ machine, interpret }` and return
  `{ machine, interpret }`. Run the result as
  `run(wrapped.machine, { interpret: wrapped.interpret, ctx })`.
- `@demlik/tea/agent` (experimental): `createAgent(...).toMachine(opts)` and
  `defineAgent(...).machine(input)` return `{ machine, interpret }`
  (`DefinedAgentWired<T>` names the latter).
