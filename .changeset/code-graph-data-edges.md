---
"@demlik/code-graph": minor
---

code-graph records which function reads or writes which Workers binding (#457).

`--data` emits one data edge per call site on a D1, Durable Object, KV, R2 or queue binding: the
function, the binding name, its kind (from the owning worker's wrangler config) and the access —
`read`, `write`, or `unknown` where the call site does not decide it. `--graph --data` carries the
same report on the graph as a new top-level `data` field, `null` when the pass did not run, so
every existing field is unchanged. The wrangler catalog now types `d1_databases`, `kv_namespaces`,
`r2_buckets` and `queues.producers`.
