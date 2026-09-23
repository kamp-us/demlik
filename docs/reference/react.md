# @demlik/tea/react

> React host adapter for `@demlik/tea`.

```ts
import { … } from "@demlik/tea/react";
```

## Exports (3)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `useMachine` | Function | Build and own a run of `machine` for the lifetime of the component mount, on the engine whose `run` the caller hands in. |
| `UseMachineOpts` | Type | Options passed to `useMachine`. |
| `useRuntime` | Function | Lower-level escape hatch: consume an externally-built, booted run — any engine's BootedRunHandle (the Promise engine's `Runtime` is one). |
