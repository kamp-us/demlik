---
"@demlik/tea": minor
---

`SpawnSteps.notify` can no longer fail. It is typed `Effect.Effect<unknown>`
where it was `Effect.Effect<unknown, unknown>`.

`spawn` runs `notify` on a fiber nothing reads, so a failure of it was seen by
nobody. The usual `notify` is `tell(parent, parentRun, msg)`, which fails with
`StoreFailed` when the parent's save fails, and that failure was lost. A bare
`notify: tell(...)` is now a compile error. Handle the failure inside the
step:

```ts
notify: tell(parent, parentRun, { type: "child_stopped", id }).pipe(
  Effect.catch((failure) => Effect.logError("notice failed", failure)),
),
```

`spawn` itself runs as before. The `notify` and `spawn` docs now say what
happens to a failure, and that a defect in `notify` ends its fiber unseen.
`docs/how-to/run-many-machines.md` and its two examples handle the failure in
the open.
