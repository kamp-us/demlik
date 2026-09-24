/**
 * @packageDocumentation
 * @demlik/tea/work-queue — a substrate-agnostic work-queue lifecycle over
 * `Store<S>`: enqueue, claim the next item, mark it done, failed or cancelled,
 * and reset whatever was running when the process went away.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/work-queue/` and re-exported unchanged; nothing moved and
 * nothing was renamed to open it. The three files behind it:
 *
 * - `work-queue` — `createQueue(store)`, the in-process adapter that binds the
 *   pure ops to an injected `Store` and runs `load → mutate → save`.
 * - `ops` — those same pure ops, unbound. A composition that owns its own
 *   Model slice delegates its status flips here instead of re-rolling them.
 * - `adapter` — the verb seam over the ops, for a caller that wants the
 *   queue's vocabulary rather than the store's.
 *
 * Both routes call the identical ops, so the lifecycle rules live in exactly
 * one place.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 */

export * from "../internal/work-queue";
export * from "../internal/work-queue/adapter";
export * from "../internal/work-queue/ops";
