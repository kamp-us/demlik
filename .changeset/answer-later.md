---
"@demlik/tea": minor
---

**Additive (declaration only):** `DispatchOptions.answerTo?: DeliveryId` opts a later Cmd-builder answer into atomically confirming that delivery with its admission. The first admitted answer wins; duplicates write nothing, while unknown ids and malformed answers are refused before writing. A corrected answer can retry in the same activation. `answerTo` requires a log store and cannot be combined with caller `id`.

The optional `LogMessage.answerTo` receipt uses protocol 3 when present. Ordinary frames and checkpoints remain protocol 2, and existing protocol-2 logs remain readable. Protocol-3 logs require the new reader; older readers refuse them. The journal and its drivers are unchanged.
