# @demlik/tea/effect

> the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields an Effect handle: the Promise engine's member names, with Effects that fail with `Stopped`, `StoreFailed` or a cell's declared failure where the Promise engine returns Promises.

```ts
import { … } from "@demlik/tea/effect";
```

## Exports (13)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `CellErrors` | Type | The failures a dispatch on the handle can end with from an `interpret` map: the error type of every hand-written Cmd's cell. |
| `EffectBootingRuntime` | Interface | What the Effect engine's `run` yields while boot is in flight. |
| `EffectInterpret` | Type | The Effect engine's `interpret` map: one cell per Cmd variant, each reading services within `R`. |
| `EffectInterpretCell` | Type | One Effect `interpret` cell. |
| `EffectRunner` | Type | One Effect sub runner: the Sub in, a `Stream` of Msgs out. |
| `EffectRunOptions` | Type | The options of the Effect engine's `run`. |
| `EffectRuntime` | Interface | The Effect engine's booted handle — what `ready` succeeds with. |
| `EffectSubscribe` | Type | The Effect engine's `subscribe` map: a runner for every Sub type the machine declares beyond the built-ins, and optionally one for a built-in, which replaces the engine's own (#270 R2.1). |
| `InterpretServices` | Type | The services every cell of an `interpret` map reads. |
| `run` | Function | Run `machine` on the Effect engine. |
| `Stopped` | Class | A dispatch the run refused because it is stopping or has stopped. |
| `StoreFailed` | Class | The run's store failed. |
| `SubscribeServices` | Type | The services every runner of a `subscribe` map reads. |
