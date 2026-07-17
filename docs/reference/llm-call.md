# @demlik/tea/llm-call

> `resilient-call` + structured-output parse + a typed failure variant, around a purpose-discriminated LLM invocation.

```ts
import { … } from "@demlik/tea/llm-call";
```

## Exports (20)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createLlmCall` | Function |  |
| `DeadlineExceeded` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `deadlineSub` | Reference | Re-export the deadline Sub primitives (inherited from resilient-call) so consumers wire one import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the Sub literal `subs` emits. |
| `DeadlineSub` | Reference |  |
| `liftLlmCall` | Function |  |
| `Llm` | Interface | The minimal chat-model contract every model the handler talks to must satisfy — the seed's `InjectableChatModel`, trimmed to the one operation llm-call drives for brain-only stages: `withStructuredOutput(schema)` → a runnable whose `invoke(messages)` resolves to a typed object matching `schema`. |
| `LlmCall` | Interface | One LLM call request — the resilient-call `input` for this knob, carried on the `resilient_run` Cmd as plain data (no closures, invariant 3). |
| `LlmCallConfig` | Interface | The llm-call knob. |
| `LlmCallPorts` | Interface | The ports the LEGACY detached `handlers(ports)` form takes. |
| `LlmErr` | Interface | The typed failure variant — every failure path surfaces this, tagged by purpose. |
| `LlmFailMsg` | Type |  |
| `LlmOk` | Interface | The parsed, typed success carried on the `resilient_ok` settle Msg, tagged with its purpose. |
| `LlmRunCmd` | Type | The effect Cmd the knob emits: run the LLM call for `key` with `input`. |
| `LlmSucceedMsg` | Type | The settle Msgs llm-call's handler RETURNS from `interpret` so the substrate enqueues them as follow-up Msgs (re-entry) into the host reducer — exactly as `../resilient-call` does. |
| `LlmTimerMsg` | Type | The retry / deadline timer Msg — `DeadlineExceeded`, inherited from resilient-call. |
| `MessageLoader` | Type | Build the `Msg[]` the handler hands to the bound model for a given call. |
| `ModelFactory` | Type | The model factory — the first DI port. |
| `ResilientState` | Reference |  |
| `Schema` | Interface | The minimal structured-output schema contract: `parse(unknown) => T`, the zod-style call the handler uses to validate the model's output before it settles `resilient_ok`. |
| `subscribeDeadline` | Reference | Re-export the deadline Sub primitives (inherited from resilient-call) so consumers wire one import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the Sub literal `subs` emits. |
