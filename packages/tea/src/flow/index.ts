/**
 * @packageDocumentation
 * @demlik/tea/flow — the multi-step control-flow batteries: fan a batch out,
 * run steps in order and compensate on failure, poll until a predicate holds,
 * reconcile desired against actual.
 *
 * A DOOR, not a module. Every name here is declared under `src/internal/flow/`
 * and re-exported unchanged; nothing moved and nothing was renamed to open it.
 * The modules behind it:
 *
 * - `await-terminal` — drive a one-shot machine to a terminal state and hand
 *   the caller a `Promise<State>` that resolves the moment it first arrives.
 * - `batch-window` — coalesce a stream of items into size- or time-bounded
 *   batches, then flush each batch as a single Cmd.
 * - `fan-out` — scatter-gather over a work list at bounded concurrency, with
 *   an optional `join` once every item has settled.
 * - `monitored-run` — an ordered stage pipeline whose position survives
 *   eviction, under a no-progress deadline and an optional durable checkpoint.
 * - `poller` — poll a source every N ms until a predicate holds, backing off
 *   on failure.
 * - `reconciler` — the desired-vs-actual sync loop: walk actual, diff against
 *   desired, apply each resulting change until the two agree.
 * - `saga` — a forward-then-compensate transaction over ordered reversible
 *   steps.
 * - `workflow` — the durable-workflow runtime core: multi-step transactions
 *   whose activities may evict the actor mid-flight.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 *
 * `monitored-run` and `reconciler` both re-export the deadline primitives
 * (`DeadlineSub`, `DeadlinesSub`, `deadlineSub`, `deadlinesSub`,
 * `subscribeDeadline`) from the one declaration
 * in `internal/resilience/deadline`, so the repeat is one symbol seen twice,
 * not two symbols contending for a name. Nothing is dropped.
 */

export * from "../internal/flow/await-terminal";
export * from "../internal/flow/batch-window";
export * from "../internal/flow/fan-out";
export * from "../internal/flow/monitored-run";
export * from "../internal/flow/poller";
export * from "../internal/flow/reconciler";
export * from "../internal/flow/saga";
export * from "../internal/flow/workflow";
