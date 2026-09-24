---
"@demlik/tea": patch
---

A `Cmd.define`d handler on a machine whose ctx is `undefined` no longer gets a
ctx typed `never`. `ok`, `err` and `emit` are callable again without a cast, on
plain and detached handlers and on agent tool handlers alike (#296).
