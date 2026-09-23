# @demlik/tea/timing

> the call-rate batteries: coalesce a burst into one fire, cap a stream to one fire per window, and gate a high-frequency input into a settled, rate-capped, optionally deduped sequence of emits.

```ts
import { … } from "@demlik/tea/timing";
```

## Exports (19)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createThrottledInput` | Function | Build a throttled-input knob from `config`. |
| `debounce` | Function | Wrap `fn` so a BURST of calls collapses to a single invocation. |
| `Debounced` | Interface | A debounced wrapper around `fn`. |
| `initThrottledInput` | Function | The starting slice: no prior emit, nothing pending. |
| `input` | Function | Feed a new input `value` arriving at clock `at` through the gates. |
| `onFlush` | Function | Emit the pending value because the settle (debounce) window closed. |
| `PendingInput` | Interface | A value held for the settle window: the `value` itself and the `at` it was held (the anchor the debounce deadline targets, `at + debounceMs`). |
| `subscribeThrottledInput` | Variable | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| `subsFor` | Function | The settle timer deadline, derived from the slice. |
| `throttle` | Function | Wrap `fn` so it runs AT MOST once per `ms` window, no matter how often it is called. |
| `Throttled` | Interface | A throttled wrapper around `fn`. |
| `ThrottledInput` | Interface | The Model slice a throttled input owns — its visible slice (the knob principle: managed state lives in the Model, never a closure, so it is durable and replayable). |
| `ThrottledInputConfig` | Type | Configuration for a throttled input — the knob. |
| `ThrottledInputKnob` | Interface | The bound knob returned by `createThrottledInput`. |
| `ThrottledInputNoCache` | Interface | The no-dedupe config variant: gates only, no cache. |
| `throttledInputSettled` | Function | Construct the Msg the deadline dispatches. |
| `ThrottledInputSettled` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `ThrottledInputSub` | Type | The deadline a throttled input's settle timer lists — a `../deadline` entry (so the window fires at the correct ABSOLUTE moment even after a late subscribe / rehydrate, and so a consumer running several gates routes each by `id`). |
| `ThrottledInputWithCache` | Interface | The dedupe config variant: a per-entry TTL plus a REQUIRED `cacheKey`. |
