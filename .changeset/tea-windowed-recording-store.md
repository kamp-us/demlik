---
"@demlik/tea": minor
---

**Additive (declaration only):** a recording store keeps a windowed trace at its live sequence numbers, and refuses an oversized frame without losing the rest.

- `SaveBoundary`'s `init` case takes an optional `skipped`: the transitions the run applied before a moved anchor. `writeTrace` (`@demlik/tea/persistence`) passes a windowed trace's `Trace.skipped` there. `doEventSourcedStore` (`@demlik/tea/do`) opens an empty log at `skipped + 1`, with a snapshot of the anchor's State there, so each later step keeps the number the live run gave it and a restore folds only the steps after the anchor. The anchor frame is not a restored boot. A log written as bare messages takes the same offset with no frame. A negative or fractional `skipped`, or one given to a log that already has frames, is refused before anything is written. `readHead` and the store find the first stored frame wherever the log starts.
- The `recording` option takes an optional `maxRowBytes`. A frame whose key and encoded cell measure more UTF-8 bytes than that, or one the storage rejects with `SQLITE_TOOBIG`, is replaced by a small refusal marker at the same seq. The next frame is written whole, and every other storage failure still rejects the save. A step's marker keeps neither its evidence nor its Msg, so the State after it is snapshotted in the same write. `onRecordingBreak` hears each marker as `{ reason: "oversized", seq, bytes, fromSeq, toSeq }`, and a hook that throws stops no later frame. `FrameRefusal` gains `"oversized"`, and a refused `StoredEvent` carries the measured `bytes`. `RecordingBreak` is now a union over its reasons.
- `EventLogReader.readTrace(range)` reads a recording back as the `Trace` it was written from, `skipped` included, for `replayTrace`. It answers `{ _tag: "unavailable", seq, reason }` for a recording it cannot read whole, a marker among them, and never returns a prefix of one. New types: `RecordedTrace` and `TraceUnavailableReason`. `StoredFrame`'s `init` frame carries `skipped`.

Without `skipped` and without `maxRowBytes`, the store writes the same bytes as before.
