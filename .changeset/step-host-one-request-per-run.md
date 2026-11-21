---
"@demlik/tea": patch
---

`stepHost` now takes the requests of one run in turn, after the token check, and keeps its settle ledger per run. A result posted twice, or a pull that arrives while the first post is still resuming, waits and then reads the State that resume produced, where it used to be answered from the State in the middle of it. A `resume` that throws no longer leaves its `callId` marked as settled, so the same post is tried again. Two runs no longer share a ledger, so a `callId` they share is settled in each. A request with a bad token still returns at once. The queue is private to one `stepHost` instance and does not order two hosts over the same run.
