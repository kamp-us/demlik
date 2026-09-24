# @demlik/tea/testing/promise

> `drive` for the Promise engine: a machine run against its real `interpret` handlers, round by round, until it goes quiet, returning `{ state, trace }` so a test asserts on the sequence as well as the endpoint.

```ts
import { … } from "@demlik/tea/testing/promise";
```

## Exports (9)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `DEFAULT_MAX_ROUNDS` | Variable | The default round bound when `opts.maxRounds` is omitted: **100**. |
| `drive` | Function | Drive `machine` from `initial` through `msg` against the REAL interpret `handlers`, feeding every settle Msg back until the machine goes quiet, and hand back the settled state together with the whole history. |
| `DriveCtxArg` | Type | `drive`'s `ctx` field. |
| `DriveNoHandlerError` | Class | Raised when a Cmd reaches `drive` with no handler for its `type` in the handler record. |
| `DriveOptions` | Type | The options both `drive`s take. |
| `DriveResult` | Interface | What a settled `drive` hands back. |
| `DriveRoundsExceededError` | Class | Raised when a driven machine is still emitting work after `maxRounds` rounds. |
| `DriveTraceEntry` | Type | One entry of a driven run's history, in dispatch order. |
| `driveTraceOf` | Function | Read back the partial trace `drive` attached to an error a handler failed with. |
