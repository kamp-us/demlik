---
"@demlik/tea": minor
---

**Additive (declaration only):** Defined-Cmd handlers may return the standalone `owed()` marker: Promise handlers accept `Outcome<Ok, E> | Owed | void`, and Effect handlers succeed with `Ok | Owed`. A handler you already wrote compiles unchanged, and `Outcome` is unchanged. **Breaking (types only):** code that calls a typed handler itself and annotates the result with the old return type (`Outcome<Ok, E> | void`, or `Effect<Ok, E, R>`) must add `| Owed`; nothing changes at run time. Export `Owed` and `owed` alongside `Outcome`, and expose `logLedger` at the root for reading surviving deliveries.

Returning `owed()` opts a logged invocation into ending without a Msg or automatic confirmation; later activations re-hand the same Cmd with the same delivery id. Without a log store it reports an interpret error. The marker stays in-process.

`DispatchOptions.answerTo?: DeliveryId` opts a later Cmd-builder answer into atomically confirming that delivery with its admission. The first admitted answer wins; duplicates write nothing, while unknown ids and malformed answers are refused before writing. A corrected answer can retry in the same activation. `answerTo` requires a log store and cannot be combined with caller `id`.

The optional `LogMessage.answerTo` receipt uses protocol 3 when present. Ordinary frames and checkpoints remain protocol 2, and existing protocol-2 logs remain readable. Protocol-3 logs require the new reader; older readers refuse them. The journal and its drivers are unchanged.
