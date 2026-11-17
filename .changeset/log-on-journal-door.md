---
"@demlik/tea": minor
---

Add the experimental `eventSourcedStore(journal, options)` on `@demlik/tea/persistence`. Hand it any journal driver plus the State, message and command schemas, and pass the result to `run` as `store`. A logged run saves each message before its step, commits State, owed work, the receipt and the automatic checkpoint as one append, runs `init` once at birth, and recovers committed State and stable delivery ids on wake. A manual checkpoint goes to a sibling stream. The store reads the driver when it opens and after a failed append; a loaded store makes no read.

Publish the experimental `Journal`, `FencedJournal`, `JournalEntry`, `JournalRead`, `JournalAppend`, `JournalRefusal`, `JournalConflict` and `EncodedRecord` types on `@demlik/tea/persistence`, and `memoryJournal` on `@demlik/tea/mem`. A driver author uses the same contract types as the factory. The conformance kit stays internal: `journalConformance` is not exported from `@demlik/tea/testing`.

**Breaking:** `memoryEventSourcedStore` is removed from `@demlik/tea/mem`. Use `eventSourcedStore(memoryJournal(), options)`. There is no facade and no reader for the Map-cell format 0.28.0 wrote; consumers pin their version until they adopt the replacement.

A plain journal-backed store requires one active writer per stream throughout the loaded activation; concurrent plain writers can corrupt history. Pass a `FencedJournal` and an explicit `{ fenced: true }` to refuse a stale writer through the existing store-failure protocol. A fenced run requires `onError`, as before.
