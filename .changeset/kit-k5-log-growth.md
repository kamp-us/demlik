---
"@demlik/tea": patch
---

`journalConformance` K5 no longer fails a driver whose append cost grows with its index depth. It allowed 3× more cost per append at 10,000 records than at 10, which an indexed table such as SQLite can exceed (3.5× measured on CI) while still truly appending; it now allows 30×. A driver that rewrites or re-reads its whole log pays about 1,000× and still fails K5.
