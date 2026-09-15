# @demlik/tea/idempotency

> do-it-once: dedupe by key, cache the result, and replay that result to every duplicate arrival.

```ts
import { … } from "@demlik/tea/idempotency";
```

## Exports (16)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createIntake` | Function | Build an idempotent-intake knob from `config`. |
| `evictExpired` | Function | Drop every entry expired at `nowMs` (older than `ttlMs`). |
| `IdempotencyEntry` | Interface | A cached entry: the result `value` the original request produced and the clock reading `atMs` it was remembered at. |
| `IdempotencyStore` | Interface | The dedupe store: a map of `key → entry`, an insertion-`order` ledger (oldest-first) that capacity eviction reads, and the two optional bounds. |
| `initStore` | Function | Create an empty store. |
| `IntakeCmd` | Type | The Cmd union the intake verbs emit. |
| `IntakeConfig` | Interface | The intake knob's config — `keyOf` derives the idempotency key from a payload, `ttlMs` (optional) ages a *completed* cached key out so a webhook replayed long after the work finished is treated as new and re-processed. |
| `IntakeEntry` | Type | A cached intake entry: either a key whose work is still in flight (`pending`) or one whose work has finished and whose `result` is held for replay to later duplicates (`done`). |
| `IntakeProcessCmd` | Type |  |
| `intakeProcessDef` | Function | A genuinely-new payload was accepted and enqueued — go run the work. |
| `IntakeReplayCmd` | Type |  |
| `intakeReplayDef` | Function | A duplicate of an already-completed key arrived — replay the cached result to the caller instead of re-running the side effect. |
| `IntakeState` | Interface | The Model slice this knob owns. |
| `recall` | Function | The cached `value` for `key` if present and unexpired at `nowMs`, else `undefined`. |
| `remember` | Function | Record `key → value` at `nowMs`, then enforce both bounds. |
| `seen` | Function | True iff `key` is present AND not expired at `nowMs`. |
