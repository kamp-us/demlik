---
"@demlik/tea": minor
---

`@demlik/tea/paginate` adds `iteratePages`, which walks a cursor- or keyset-paged API as a pull-driven async iterator that yields each page unchanged:

```ts
for await (const page of iteratePages({ firstCursor, fetchPage, nextCursor })) {
  // per-page work
}
```

It interprets the paginator ops (`start`, `recordPage`) with backpressure off. Nothing is fetched before the first pull, the next page is fetched only after the loop body for the current one finishes, and a `break` or `return` ends the walk without reading the continuation. `nextCursor` returning `null` or `undefined` ends the walk; any other value, including `0` and `""`, is fetched next. A `fetchPage` rejection reaches the `for await` unchanged. Additive: no existing export changes.
