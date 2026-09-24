# @demlik/tea/promise

> the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, and `driveToDone` runs one to its terminal state.

```ts
import { … } from "@demlik/tea/promise";
```

## Exports (3)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `driveToDone` | Function | Drive a machine from `start` to its terminal State in one call, then tear the runtime down. |
| `DriveToDoneOptions` | Type | Options for `driveToDone`. |
| `run` | Function |  |
