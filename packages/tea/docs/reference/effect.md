# @demlik/tea/effect

> the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields the same run handle the Promise engine returns.

```ts
import { … } from "@demlik/tea/effect";
```

## Exports (8)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `EffectInterpret` | Type | The Effect engine's `interpret` map: one cell per Cmd variant, each reading services within `R`. |
| `EffectInterpretCell` | Type | One Effect `interpret` cell. |
| `EffectRunner` | Type | One Effect sub runner: the Sub in, a `Stream` of Msgs out. |
| `EffectRunOptions` | Type | The options of the Effect engine's `run`. |
| `EffectSubscribe` | Type | The Effect engine's `subscribe` map: a runner for every Sub type the machine declares beyond the built-ins, and optionally one for a built-in, which replaces the engine's own (#270 R2.1). |
| `InterpretServices` | Type | The services every cell of an `interpret` map reads. |
| `run` | Function | Run `machine` on the Effect engine. |
| `SubscribeServices` | Type | The services every runner of a `subscribe` map reads. |
