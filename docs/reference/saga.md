# @demlik/tea/saga

> a forward-then-compensate transaction over an ordered list of reversible steps.

```ts
import { … } from "@demlik/tea/saga";
```

## Exports (11)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createSaga` | Function |  |
| `initSaga` | Function |  |
| `isAborted` | Function |  |
| `isCommitted` | Function |  |
| `isCompensationFailed` | Function |  |
| `isSettled` | Function |  |
| `SagaConfig` | Interface | The knob. |
| `SagaPhase` | Type | The lifecycle phase of a saga, narrowed at the type level so a consumer can branch on `state.phase` (and a Transitions-table reducer can key on it). |
| `SagaState` | Interface | The slice this knob owns. |
| `SagaStep` | Interface | One step of the saga: the forward effect and its compensating inverse, both as data (plain Cmds). |
| `StepId` | Type | A step's stable identity. |
