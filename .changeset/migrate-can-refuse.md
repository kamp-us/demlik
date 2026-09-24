---
"@demlik/tea": minor
---

`run` now refuses saved state it cannot read instead of booting fresh over it
(#316). Before, a `migrate` that returned `null` for bytes it did not recognize
booted a fresh run, and the first save overwrote those bytes for good, so a
buggy migration wiped the user's saved state.

- **`Store.migrate` return type changed:** it now returns `Migrated<S>`, which is
  `S | null | Refusal`. `null` still means "nothing was saved, boot fresh". Return
  the new `refuse(reason)` for saved bytes you cannot read.
- On a refusal, `ready` rejects with the new `StoreRefusedError` (`_tag:
  "store_refused"`, `reason`) and nothing is written. A `load` or `migrate` that
  throws is refused the same way, with the throw as `cause` — so a corrupt
  `fileStore` / `doStore` file now rejects `ready` with a `StoreRefusedError`
  instead of the raw `SyntaxError`. Both engines behave the same.
- `schemaMigrate` now refuses saved bytes the schema rejects, or that make
  `upcast` throw. It still returns `null` for `null` / `undefined` (nothing
  saved).
- The `parse` argument of `fileStore`, `memoryStore`, `doStore` and
  `chromeStorageStore` may return a refusal too.
- `createQueue` (`@demlik/tea/work-queue`) throws `StoreRefusedError` on a queue
  it cannot read, rather than treating it as empty and saving over it.

There is no placeholder or "saving is off" mode. A host that wants a "couldn't
restore" view catches `StoreRefusedError` and starts its own run with no store —
see the new how-to "Show a 'couldn't restore' view".

**Breaking:** code that reads `store.migrate(...)` directly now gets
`S | null | Refusal`; narrow with `instanceof Refusal`. A custom `migrate` that
returned `null` for unreadable bytes still boots fresh — switch it to
`refuse(reason)` to get the protection.
