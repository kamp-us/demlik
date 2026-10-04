---
"@demlik/tea": patch
---

`fileJournal`'s TSDoc now carries `@experimental`, so an editor hover says what
`MAINTAINING.md` already did: it has no stability promise, even though `./node`
is `stable`. The generated reference pages now print each export's declaration
and tier, and `./machine-viz` and `./parity` have pages.
