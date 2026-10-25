The native paginated walk composes the existing paginator and resilient-call.
The paginator chooses and counts pages; resilient-call admits and retries the
fetch for the fixed `page` key. The caller retains its typed page callback,
command enum, host reducer and interpreter.

`Config::new` takes a first `CallValue<Cursor>`, `Rc<Fn>` next-cursor callback and
`Rc<Fn>` page callback. A callback returns `Result`, preserving a typed cause
and the phase that failed. Optional page size, high-water mark, count-bounded
retry, circuit, rate and per-page deadline configuration use their existing
owners. The pure API needs neither Clone/serde/Send on cursor, page or failure,
nor a runtime tag on the caller's emitted command. `From<RunCommand<...>>`
selects the caller's fetch variant. Runtime tagging remains at the existing
machine boundary.

The actual source verbs are the reference. In particular, `resume` only opens a
paused backpressure valve after `drain`. A restored `fetching` state remains a
no-op on start/resume; this composition does not invoke resilient-call's separate
resume verb. Late successes still settle and run callbacks. Late errors and
timers preserve the whole state outside fetching. Page commands precede the
next fetch. Both null and undefined next cursors end a page sequence.

The standalone shared corpus observes pure state, callback order, identity,
commands, failure predicates and timers before any explicit JSON roundtrip.
JSON reloads alone apply undefined omission and nonfinite-to-null conversion.
The native adapter reads canonical PlainData, including lone UTF-16 units and
JSON number overflow. Raw malformed protocol envelopes are refused by each
language's existing boundary validation, without recreating vendor diagnostics.

Run with the isolated Rust environment and the pinned Node 22.21.1 profile:

```sh
pnpm --filter @demlik/parity exec node paginated-walk-run.mjs
pnpm --filter @demlik/parity exec node paginated-walk-coverage.mjs
pnpm --filter @demlik/parity exec node paginated-walk-mutations.mjs
pnpm --filter @demlik/parity exec node paginated-walk-runtime.mjs
cargo test --locked -p demlik-tea --test paginated_walk --test paginated_walk_runtime
cargo test --locked -p demlik-tea --doc
pnpm --filter @demlik/parity exec tsc --noEmit -p tsconfig.json
```

Reports are `target/parity/paginated-walk{,-coverage,-mutations,-runtime}.json`.
Coverage maps every walk export and referenced callable member to actual
compiled public calls. Shared core aliases retain their canonical owners.
Controls build changed native source in disposable copies, require the named
TypeScript and Rust requests both to execute successfully, then require their
behavior to differ. The active source and frozen TypeScript remain unchanged.

The Runtime consumer runs Promise/Effect × success/retry-once/terminal failure
with the actual default timer. It carries opaque cursor/page types without
Clone/serde, proves command order and shared failure identity, and awaits stop.
The public wrong-page completion compile-fail doc and private TypeScript
negative checks preserve precise cursor and page types. An actual recursive
page callback runs twice in both languages.

Blind spots: runtime command tags retain the existing UTF-8 interface; this
slice does not repair that shared boundary. Native futures use the existing
executor contract. Full-package completion is tracked by the parent gate;
these reports claim only the walk composition and its existing-owner aliases.
