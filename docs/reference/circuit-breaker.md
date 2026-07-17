# @demlik/tea/circuit-breaker

> per-target failure tracking as pure state + ops.

```ts
import { … } from "@demlik/tea/circuit-breaker";
```

## Exports (7)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `canPass` | Function |  |
| `CircuitPolicy` | Interface | Circuit-breaker policy — pure configuration, no mutable state. |
| `CircuitState` | Type | The breaker's phase. |
| `defaultCircuitPolicy` | Variable | Sensible defaults: trip after 5 consecutive failures, cool down for 30s, admit a single probe before deciding. |
| `initCircuit` | Function |  |
| `onFailure` | Function |  |
| `onSuccess` | Function |  |
