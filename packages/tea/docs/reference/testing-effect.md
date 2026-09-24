# @demlik/tea/testing/effect

> `drive` for the Effect engine: a machine run against its real Effect `interpret` handlers and its Subs, round by round, until it goes quiet, yielding `{ state, trace }`. The services the handlers read come from the caller's Layers.

```ts
import { … } from "@demlik/tea/testing/effect";
```

## Exports (11)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `DEFAULT_MAX_ROUNDS` | Variable | The default round bound when `opts.maxRounds` is omitted: **100**. |
| `drive` | Function | Drive `machine` from `initial` through `msg` against the REAL Effect `interpret` map — the one a host hands the Effect engine's `run` — and the Subs the machine wants, feeding every Msg back until the machine goes quiet. |
| `DriveCtxArg` | Type | `drive`'s `ctx` field. |
| `DriveNoHandlerError` | Class | Raised when a Cmd reaches `drive` with no handler for its `type` in the handler record. |
| `DriveOptions` | Type | The options both `drive`s take. |
| `DriveResult` | Interface | What a settled `drive` hands back. |
| `DriveRoundsExceededError` | Class | Raised when a driven machine is still emitting work after `maxRounds` rounds. |
| `DriveTraceEntry` | Type | One entry of a driven run's history, in dispatch order. |
| `driveTraceOf` | Function | Read back the partial trace `drive` attached to an error a handler failed with. |
| `EffectDriveError` | Type | The failures a drive ends with: the loop's own, and a hand-written cell's. |
| `EffectDriveOptions` | Type | The Effect `drive`'s options: the Promise `drive`'s, plus `subscribe` — the runners the engine's `run` takes, required exactly when `run` requires them. |
