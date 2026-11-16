---
"@demlik/tea": minor
---

Add `LoggedStore`, the neutral log declarations and `logUpdates`, plus
`memoryEventSourcedStore` over a caller-owned serialized Map. Logged runs save
messages before reduction, commit State and owed work atomically, initialize
once at birth, and recover committed State and stable delivery IDs on wake.
The durable ledger and receiver helpers are also available from the root;
existing `/do` imports continue to work.

**Additive (declaration only):** dispatch and dispatchOnce accept an optional
caller `id`, and Effect handlers accept an optional invocation context for
`deliveryIdOf`. Stores without a log retain their existing lifecycle and
save-failure behavior. This slice adds no fenced, file or Durable Object log
adapter and persists no timer decisions.

Append individual records through an incremental projection instead of rewriting
and revalidating history. Refuse State/Cmd payloads that change through the
schema/JSON round trip, and retain detached contract failures as owed work.
