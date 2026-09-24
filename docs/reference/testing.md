# @demlik/tea/testing

> test-side ergonomics over @demlik/tea's pure substrate.

```ts
import { … } from "@demlik/tea/testing";
```

## Exports (22)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `bindMachine` | Function | Bind a machine + ctx into a small bag of 2-arg helpers. |
| `BoundMachine` | Interface | The bound testing surface. |
| `DEFAULT_MAX_ROUNDS` | Variable | The default round bound when `opts.maxRounds` is omitted: **100**. |
| `drive` | Function | Drive `machine` from `initial` through `msg` against the REAL interpret `handlers`, feeding every settle Msg back until the machine goes quiet, and hand back the settled state together with the whole history. |
| `DriveCtxArg` | Type | drive's `ctx` field. |
| `DriveNoHandlerError` | Class | Raised when a Cmd reaches drive with no handler for its `type` in the `handlers` record. |
| `DriveOptions` | Type | drive's options. |
| `DriveResult` | Interface | What a settled drive hands back. |
| `DriveRoundsExceededError` | Class | Raised when a driven machine is still emitting work after `maxRounds` rounds. |
| `DriveTraceEntry` | Type | One entry of a driven run's history, in dispatch order. |
| `driveTraceOf` | Function | Read back the partial trace `drive` attached to an error a handler rejected with. |
| `expectActiveSubs` | Function | Assert the exact set of subs desired at the final state after replaying `opts.msgs`. |
| `expectCmdEmitted` | Function | Assert that `cmd` appears at least once in the cmds array produced by replaying `opts.msgs`. |
| `expectCmdSequence` | Function | Assert the exact ordered sequence of cmds emitted by replaying `opts.msgs`. |
| `expectFinalState` | Function | Assert the final state after replaying `opts.msgs` equals `expected`. |
| `expectReplayDeterministic` | Function | Assert that replaying `opts.msgs` is a pure function of the Msg log: the final state and every emitted Cmd come out the same under two different global wall-clocks and RNG seeds. |
| `noopRuntime` | Function | Construct an inert `Runtime<S, M>` value. |
| `ReplayOpts` | Interface | Shared options shape for every test assertion below. |
| `stateFactory` | Function | Build a typed phase-constructor API from per-phase defaults. |
| `StateFactoryAPI` | Type | The API returned by `stateFactory`. |
| `StateFactoryDefaults` | Type | Defaults shape passed to `stateFactory`. |
| `step` | Function | Single-msg step helper — feeds `loaded → msg → next state + cmds emitted by that msg`. |
