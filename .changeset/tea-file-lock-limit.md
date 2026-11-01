---
"@demlik/tea": minor
---

A leftover file lock no longer hangs a write forever. The fenced `fileStore` and
`fileJournal` now steal a lock whose holder is proven gone: an empty one older
than a short grace period, one from an earlier boot of this machine, or one whose
process is dead. Any other lock is waited on for up to 10 seconds, and then the
write rejects with a new `FileLockTimeoutError` from `@demlik/tea/node`, which
names the lock file.

A lock from another host is never stolen, because that host may be live on a
shared volume. Restoring a folder onto a new machine can therefore end the first
write in that error; once the old machine is known to be gone, delete the file.

Lock files now record the writer's host and boot as well as its process id. The
old format, a bare process id, is still read.
