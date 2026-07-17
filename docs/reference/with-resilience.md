# @demlik/tea/with-resilience

> the INTERCEPTING wrapper of the wrapper tier.

```ts
import { … } from "@demlik/tea/with-resilience";
```

## Exports (10)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `ResilienceCmd` | Type | Every Cmd the wrapper adds to the base's Cmd union. |
| `ResilienceConfig` | Interface | The `withResilience` knob. |
| `ResilienceErrMsg` | Type | The error Msg the `$resilience:run` handler dispatches back when the base interpret threw / rejected. |
| `ResilienceModel` | Interface | The composed Model. |
| `ResilienceMsg` | Type | Every Msg the wrapper adds to the base's Msg union. |
| `ResilienceOkMsg` | Type | The success Msg the `$resilience:run` handler dispatches back when the base interpret resolved OK. |
| `ResilienceRunCmd` | Type | The carrier Cmd the wrapper emits when the gate ADMITS a target base Cmd. |
| `ResilienceTimerMsg` | Type | The retry / deadline timer Msg the `$resilience:timer` Sub dispatches when the wall clock crosses the armed instant. |
| `ResilienceTimerSub` | Type | The Sub the wrapper adds — a deadline-style timer in the `$resilience` family. |
| `withResilience` | Function |  |
