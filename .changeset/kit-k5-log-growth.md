---
"@demlik/tea": patch
---

`journalConformance` K5 no longer fails a driver at random on sub-millisecond timing. It failed whenever one append cost more than 3x at 10,000 records than at 10; SQLite measured 0.22 ms and 0.77 ms on CI and failed, though it truly appends. K5 now also requires that extra cost to be over 1 ms (`now` is a millisecond clock). K5 is a timing check on two sizes, so it still cannot see a whole-log read whose cost stays under 3x a large fixed cost per call (10 ms per call plus 1 µs per record is 2x), and it no longer sees one that adds under 1 ms in all, such as an in-memory scan.
