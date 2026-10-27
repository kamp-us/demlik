# Typed subscription runtime checkpoint

This checkpoint executes the reviewed fallible projection interface through the
existing Promise and Effect actors. The only new production change is in the
actor worker: allow the step result continuation to publish already-started
cleanup rejection, and publish a caller receipt before notifying the swallowed
tail's drain waiters. The Source reference is `internal/engine/loop.ts`:
`stepDispatch`, `enqueueDispatch` (`next`, then `tail = next.catch`),
`trackDisposal`, and `drainTail`. No scheduler, admission model, copied validity
facts, separate error family or new executor is introduced.

`subscription-conformance-run.mjs` compares 65 strict scripts, retains 3 qualified
observations separately, and checks 4 protocol refusals. It compares the full
ordered trace and concrete state, saves, effects, callbacks, live resource
identities, reports and receipts. Cause comparisons refer to the authored/core
cause. Source Effect `StoreFailed` wrappers are allocated at its handle boundary;
the native `RuntimeError` wrappers and all raw Source profiles remain separate.
The native tests additionally prove cached outer `Rc` identity after dropping the
runtime. No equality of raw JS error names, prototypes or wrapper allocation is
claimed. Producer action acknowledgements mean the actual callback was invoked;
transition failures are read from follow-up reports, not from an imagined
awaitable producer receipt. Before a failed Source `ready`, model observations
retain the object received/created by `init`, not an unavailable public handle.

The eight native tests exercise opaque non-Clone/non-Debug/non-Send causes,
post-save refusal, retained loaded state, whole-state refusal, scope and runner
error identity, interruption and bounded cleanup. The canonical AgentState test
restores its original `Rc` through the real memory store and invokes the actual
Agent projection directly. AgentState's current runtime tag/wiring is not
implemented here; no wrapper model or purported `toMachine` execution is used.

The inherited interface is commit `a24b37cdb927a4a2c3d9b9fc0ec26a280dc989a6`.
Its original missing-interface red and pure/type checks are preserved in
`/private/tmp/demlik-subscription-interface-proof-01a16c9d`. This checkpoint
rechecks its two intended type refusals and owned positive against actual
Cargo-selected libraries. Those are compatibility evidence, not new Source IDs.

## Open adapter qualification

The three Effect cleanup rows are excluded from strict `nativeEvidence` and have
an explicit open gap on the Effect run mapping. Source's Stream finalizer fails
with the original cause, but its runner calls `Fiber.interrupt`, which resolves
void after awaiting the fiber. Effect 4.0.0-rc.117 implements this as
`asVoid(fiberAwait(self))` (`src/internal/effect.ts:929`;
`src/Fiber.ts:379`). The completed fiber's failure Exit can be inspected
separately. Native SubscriptionWork's cleanup `Result` is reported under
`sub-cleanup`. Native errors are retained, never silenced to force equality.

`subscription-effect-cleanup-probe.mts` runs a real fiber, observes the original
failure in both finalizer and completed fiber Exits, and verifies interruption
resolves undefined. This is Source-only evidence, with zero new shared/native
credit. An earlier report described an Exit as returned by `Fiber.interrupt`;
that interpretation was wrong. Historical reports are retained as recovery
records; the current qualification follows the real dependency source and probe.

The existing 8 uncoordinated scheduling gaps, raw tag/prototype profiles, builtin
AgentTurn raw projection, malformed original-command errOf/decode, missing/null
settlement timestamps and optional restored-agent resume/refusal differences
remain open. No agent brain/interpreter/router/tool/provider/SDK wiring is added.

## Reproduction

Use the repository's pinned Rust and reference Node toolchains, offline, one job,
debug=0, incremental=0. Unset all Cargo target-directory override variables.
Each suite runs in a registered worktree with its own default `target/`.

- `pnpm exec node verification/parity/subscription-conformance-gates.mjs`
- `pnpm exec node verification/parity/subscription-conformance-run.mjs`
- `pnpm exec node verification/parity/subscription-conformance-checks.mjs OPTIONS.json`

The fault options name the actual selected baseline driver, eight-test owner
binary, full 65+3 baseline report, 94-case typed-reducer report/driver and an
external evidence directory. One sequential fault suite restores exact owner
bytes before each of 13 new and 4 inherited faults, requires the modified library
and effective driver to be rebuilt, and copies executed artifacts before the next
fault. Compile, process and protocol failures never count as semantic detection.
The suite removes its registered worktree/default target in `finally`.
