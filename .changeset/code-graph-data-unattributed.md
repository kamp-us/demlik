---
"@demlik/code-graph": patch
---

`--data` no longer drops binding sites silently (#460).

A call site with no named function around it — a module-scope Hono handler,
`app.get("/", (c) => c.env.DB.prepare(...))` — used to produce nothing. It now lands in a new
`unattributed` array on the `DataReport`, carrying its file, line and column, and the human report
counts it. Every data edge gains a `column`, and edges are deduplicated on it, so two same-method
calls on one line (a read beside a write in one `db.batch([...])`) stay two edges instead of
collapsing into the last one. Both fields are additive.
