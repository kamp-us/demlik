---
"@demlik/tea": minor
---

Add the experimental `eventSourcedStore(journal, options)` on `@demlik/tea/persistence`. Supply the State, message and command schemas with any conforming journal driver. Logged runs save messages before reduction, atomically commit State, owed work, receipt and automatic checkpoint, initialize once at birth, and recover committed State and stable delivery IDs on wake. Manual checkpoints use a sibling stream. Memory and file drivers share the durable assertions.

**Breaking:** `fileJournal` on `@demlik/tea/node` takes opaque text batches and optional `{ fenced: true }` instead of a record parser; remove `memoryEventSourcedStore` from `@demlik/tea/mem`; use `eventSourcedStore` with a memory journal instead. There is no compatibility facade or migration reader for the unreleased Map-cell format; consumers pin their package version until they adopt the replacement.

Plain journals require one writer per stream. Pass a `FencedJournal` and explicit `{ fenced: true }` to the factory to refuse a stale writer through the existing store-failure protocol. A fenced run requires `onError` as before.

The durable ledger and receiver helpers remain available from the root; existing `/do` imports continue to work. **Additive (declaration only):** dispatch and dispatchOnce accept an optional caller `id`, and Effect handlers accept an optional invocation context for `deliveryIdOf`. Stores without a log retain their existing lifecycle and save-failure behavior. This change adds no timer decisions or deployed-host integration.

The program sees Msg, State and Cmd values as decoded from stored text, both live and after wake. Ignored and rejected messages save a receipt without rewriting State; detached contract failures remain owed work.
