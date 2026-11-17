---
"@demlik/tea": patch
---

**Breaking (experimental):** replace `fileJournal<R>(dir, parse)` with the calls below.

The new `fileJournal(dir)` call takes opaque Unicode text from its callers instead of a record-parser argument.
The unfenced file journal takes no lock (it used to lock every append), so one writer per stream is the caller's precondition.
`fileJournal(dir, { fenced: true })` gives the checked append, `appendFenced(stream, [encoded], expectedHead)`, under the existing `wx` stream lock.

Append a nonempty batch with `append(stream, [encoded])` and use its acknowledged
stored entries. Use `read(stream, after)` in place of `list(stream)`. Refusals are
tagged data; a lost expected head is `journal_conflict`, and an unavailable lock
is `journal_io` for `append` with `uncertain: false` and the lock's clear step.
The listener and caller lock methods are removed.

Stream file names changed to lowercase UTF-8 byte escapes, keeping letter case and Unicode normalization forms distinct on every volume.

File appends add one complete batch frame instead of rewriting history. The file
format changes from `{ seq, record }` lines to arrays of encoded strings, one
batch per line; existing files need migration. Reads preserve an incomplete
tail, and the next append repairs it. The contract, memory driver, optional
memory fencing and shared conformance kit stay internal.
