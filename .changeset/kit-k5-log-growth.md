---
"@demlik/tea": patch
---

`journalConformance` K5 no longer fails a driver at random on sub-millisecond timing. It failed when one append cost more than 3x at 10,000 records than at 10; SQLite measured 0.22 ms and 0.77 ms on CI and failed, though it truly appends. K5 now also requires that extra cost to be over 1 ms (`now` is a millisecond clock). A driver that reads or rewrites its whole log still fails, including one behind a slow fixed cost per call: 1 ms plus 1 us per record costs 10 ms more at 10,000 records.
