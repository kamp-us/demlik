# Verify native Reconciler

The source reference is `packages/tea/src/internal/flow/reconciler/index.ts` at
`75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`. This checkpoint composes the existing
native paginated walk and TTL cache. It adds no executor, parser, schema runtime,
registry or independent cache.

`Config::with_id` accepts typed callbacks and preserves borrowed, non-Clone,
non-serde desired values, pages, actual items, changes and cursor payloads.
`Config::new` selects the source's default JSON identity and requires
`Change: Serialize` only at that constructor. State snapshots share typed values
through `Rc`; conditional Serde implementations are boundary codecs, without
bounds on pure transitions. Callbacks return `Result`; their phase and typed
cause remain observable. The callback owner uses `Rc<dyn Fn>` so real reentry
can call the same callback again without a mutable callback borrow.

The cache owns optional JSON-key conversion: absent JSON identity addresses the
literal `undefined` key. It also owns TTL and prototype lookup. Typed stored
changes need no codec. A caller using opaque values in reflected or injected
ledger entries supplies `with_ledger_projection` at the existing cache
projection boundary; a missing or failing projection returns an error. The
canonical serializer supplies this port for the shared data trace driver.

Run under the pinned Node 22.21.1 / V8 12.4.254.21-node.33 reference and the
repository Rust toolchain. Scope Cargo paths to the current worktree. Set
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
CARGO_BUILD_JOBS=1` for these verifiers and their children.

```sh
pnpm --filter @demlik/parity exec node reconciler-run.mjs
pnpm --filter @demlik/parity exec node reconciler-runtime.mjs
pnpm --filter @demlik/parity exec node reconciler-cache-owner.mjs
pnpm --filter @demlik/parity exec node reconciler-mutations.mjs
pnpm --filter @demlik/parity exec node reconciler-coverage.mjs
```

The action corpus has 74 scripts and 300 actions, plus 11 protocol refusals.
Independent expected literals and direct source/native comparison cover scan,
plan, acknowledgment, retry, rate, circuit, deadlines, callback failures, identity,
late frames and restore. Default identity witnesses distinguish object property
order from structural hashing and cover undefined, nonfinite values and UTF-16.
The source and native callback fixtures also prove reentry and that a stored
undefined acknowledgment does not suppress a defined change with the same ID.

The native Runtime consumer runs success, one retry and terminal failure in both
profiles, using the actual default timer and awaiting stop. Opaque payloads and
shared failure identity/mutation are asserted before the six receipts are printed.
The 13 compiled controls require behavioral failures from disposable source
copies. Mutants use one dedicated lean target, separate from the baseline target.
The canonical timer control also adapts the disposable Reconciler signature so
it compiles with the deliberately foreign timer type; production uses the
canonical `crate::TimerDeps`.

Reports are `target/parity/reconciler{,-runtime,-cache-owner,-mutations,-coverage}.json`.
The strict ledger contains all 70 scoped discovered capabilities. Central runner
and ledger registration remain the parent integration step. Existing native
future scheduling and UTF-8 runtime tag qualifications remain; no JavaScript
microtask engine is introduced. Generic opaque restore requires the caller's
Serde decoder at the explicit persistence boundary. Full-package completion is
still governed by the parent capability gate.
