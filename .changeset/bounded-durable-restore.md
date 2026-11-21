---
"@demlik/tea": minor
---

Bound Durable Object event replay to storage query ranges and pages of 128 rows.
Fold events incrementally and discard historical commands in state-only folds.

**Additive (declaration only):** `EventSourcedOptions` adds `restoreRetryLimit`
(default 1) and `keys.restoreAttempt`. `EventSourcedStore` adds
`getCommittedSeq(): Promise<number>`. The `@demlik/tea/do` entry exports
`RestoreAttempt` and `RestoreInterruptedError`.

Loads persist a JSON attempt record before expensive reads and clear it only
on success. An initial attempt and one unfinished retry exhaust the default
budget; later loads refuse without reading the snapshot or journal. Loads
sharing a storage object and meta key are serialized. The runtime preserves
typed refusal causes and never boots fresh after a rejected restore.

**Breaking (restore behavior):** an unrecognized persisted snapshot or invalid
sequence now refuses restore instead of falling back to full-history replay.
Repeated load failures also exhaust the restore budget. Inspect and repair
retained data before explicitly clearing the attempt record to allow recovery.
