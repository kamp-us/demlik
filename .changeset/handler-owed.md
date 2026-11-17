---
"@demlik/tea": minor
---

**Additive (declaration only):** Defined-Cmd handlers may return the standalone `owed()` marker: Promise handlers accept `Outcome<Ok, E> | Owed | void`, and Effect handlers succeed with `Ok | Owed`. Existing handler signatures and `Outcome` stay compatible. Export `Owed` and `owed` alongside `Outcome`, and expose `logLedger` at the root for reading surviving deliveries.

Returning `owed()` opts a logged invocation into ending without a Msg or automatic confirmation; later activations re-hand the same Cmd with the same delivery id. Without a log store it reports an interpret error. The marker stays in-process; the log and wire format do not change.

Until later-answer support lands, only the store's existing `confirmEffect(id)` clears an entry left owed this way.
