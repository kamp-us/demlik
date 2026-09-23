---
"@demlik/tea": minor
---

**Breaking (battery tier):** the battery layer is gone (ADR 0022). There are no
`mount*` helpers and no `withResilience` / `withDeadline` wrappers. Reusable
logic is plain functions plus `Cmd.define`d Cmds you call from your own
`update`. The L2 helpers lose `handlers(ports)`: each ships its run Cmd, and you
write that Cmd's handler in your engine's style. It returns an outcome, and the
engine mints the settle Msg (ADR 0021). Their retry timers use the built-in
`timer` Sub, so `run` needs no `subscribe` for them.

```ts
// before
const mounted = mountResilientCall(rc, { slice: "call", attempt, onOk, onErr });
run(machine, { interpret: rc.handlers({ run: fetchUser }), subscribe: { deadline: subscribeDeadline } });

// after
defineMachine({
  types, cmds: [rc.run], init,
  update: {
    load: (s, m) => { const [call, cmds] = rc.attempt(s.call, m.id, m.id, m.at); return [{ ...s, call }, cmds]; },
    resilient_run_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
    resilient_run_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
    deadline_exceeded: (s, m) => { const [call, cmds] = rc.onTimer(s.call, m); return [{ ...s, call }, cmds]; },
  },
  subs: [{ type: "timer", deps: (s) => rc.timer(s.call) }],
});
run(machine, {
  interpret: {
    resilient_run: async (cmd, { ok, err }) => {
      try { return ok(await fetchUser(cmd.input)); }
      catch (cause) { return err({ _tag: "port_rejected", cause }); }
    },
  },
});
```

`docs/how-to/hand-wire-a-resilient-call.md` walks the whole machine.

`./resilience`:

- Removed: `withResilience` (with `resilienceRunCmdDef`, `ResilienceConfig`,
  `ResilienceModel`, `ResilienceCmd`, `ResilienceMsg`, `ResilienceOkMsg`,
  `ResilienceErrMsg`, `ResilienceRunCmd`, `ResilienceTimerMsg`,
  `ResilienceTimerSub`), `withDeadline` (with `deadlineDecision`,
  `deadlineExceededMsg`, its `DeadlineConfig`, `DeadlineExceededMsg`,
  `DeadlineModel`, `DeadlineSlice`, `DeadlineDecisionCmd`,
  `ProgressPredicate`), `mountResilientCall` (with `MountableKnob`,
  `MountConfig`, `MountedCell`, `MountedResilientCall`, `DeadlineSettled`,
  `Settle`, `SettleFold`), `ResilientHandlers` and `ResilientPorts`.
  `ResilientCallDeadlineConfig` keeps its name.
- `createResilientCall`: `handlers` is gone; `run` is the `Cmd.define`d run
  Cmd (`<name>_run`). Its settle Msgs are the engine-minted `<name>_run_ok`
  (`{ cmd, value, at }`) and `<name>_run_err` (`{ cmd, error, at }`), so a
  named knob's `jev_ok` is now `jev_run_ok`. A handler fails with
  `err({ _tag: "port_rejected", … })` (or `"deadline_exceeded"`); a throw goes
  to the error sink and is not retried. New: `RunErr`, `SettleMsg`.
- `subs(slice)` is renamed `deadlines(slice)`. New `timer(slice)` returns the
  built-in `timer` Sub's deps for the soonest deadline. The slice gains
  `clockMs`, the instant of its latest clocked transition, which `timer`
  counts down from. `settleFailed` takes `at`.
- `SucceedMsg` / `FailMsg` are the minted shapes above; `FailMsg` takes an
  optional error type. `RunCmd` takes an optional result type.
- New in `deadline`: `nextTimer(deadlines, nowMs)`, the built-in `timer` deps
  for the soonest of a deadline list.
- `token-refresh`: `handlers` / `TokenRefreshPorts` and the
  `tokenRefreshedMsg` / `tokenRefreshFailedMsg` constructors are gone. `run`
  is the `refresh_token` def; `TokenRefreshedMsg` / `TokenRefreshFailedMsg`
  are its minted `refresh_token_ok` / `refresh_token_err`.
- `authed-call`: `refresh` leaves the config, `handlers` and `AuthedPorts`
  are gone, `succeed(s, msg)` / `fail(s, msg)` read the key off `msg.cmd`,
  and the knob exposes `run`, `refresh`, `deadlines` and `timer`.

`./paginate` / `./flow`:

- `paginated-walk`: `handlers` and `PaginatedWalkPorts` are gone;
  `pageOk(s, msg)` / `pageErr(s, msg)` take the minted Msg; `fetch` is the
  page-fetch def; `subs` → `deadlines`, plus `timer`. The deadline
  re-exports are gone (import them from `./resilience`).
- `reconciler`: the same — `ReconcilerPorts` and `handlers` gone,
  `pageOk(s, msg)` / `pageErr(s, msg)`, `scanPage` def, `deadlines` / `timer`.
- `monitored-run`: `handlers` / `MonitoredRunPorts` gone; `checkpoint` is the
  `snapshot_write` def; `subs` → `deadlines`, plus `timer`.
- `batch-window`: the knob's `handlers()` is gone; new `timer` / `timerFor`
  arm the window on the built-in `timer`. `subs` and `subscribeBatchWindow`
  stay for the absolute-deadline form.
- `fan-out`: `handlers(ports)` is renamed `completion(ports)`.

`./persistence`:

- `snapshot`: `handlers`, `SnapshotStore`, `SnapshotPorts` and the
  `snapshotSaved` / `snapshotFailed` / `snapshotLoaded` / `snapshotLoadFailed`
  constructors are gone. `write` / `load` are the Cmd defs
  (`snapshotWriteDef<V>()`, new `snapshotLoadDef<V>()` replacing the
  `snapshotLoad` constant); their Msgs are the minted `snapshot_write_ok` /
  `_err` and `snapshot_load_ok` / `_err`. `confirm` reads `msg.cmd.seq`.

`./jev`:

- `JevPort`, the `port` config, `handlers`, `ask()`, `JevAskFailure`,
  `JevSub` and the deadline / mount re-exports are gone. The HTTP call is
  your `resilient_run` handler: it returns `ask.decode(request, reply)` (new
  pure `decodeJevReply`), `ask.rejected(cause)` (`jevCallThrew`) or
  `ask.offline(request)` (`offlineJevAnswer`). New: `JevHttpReply`,
  `JevRejected`, `jevAskErrOf`. `succeed(s, msg)` / `fail(s, msg)` take the
  minted Msg; `fail` stores the typed `JevAskErr`.
- `classify-batch`: `port` and `handlers` gone; `ask` is the Cmd def and
  `decode` / `rejected` / `offline` build the handler's outcome. `subEntries`
  arms the window on the built-in `timer`; `subscribers()` returns only the
  cache eviction runner.

`./agent` (experimental):

- `unsafeDetachedHandlers`, `AgentPorts` and `AgentDetachedHandlers` are gone.
  New: `brainInterpret()` (the brain call's handler) and `brain` (its
  `Cmd.define`d def). `toMachine()` lists the brain def in `cmds`.
- `succeed(s, msg, at)` / `fail(s, msg, at)` take no key. The brain settle
  Msgs are the minted `resilient_run_ok` / `resilient_run_err`; an `llm`
  failure's `error` is the `LlmErr` read off the Msg.

`./testing`: `drive` now mints a `Cmd.define`d Cmd's outcome into its settle
Msg through the machine's `cmds`, as `run` does, and takes an optional `clock`.
