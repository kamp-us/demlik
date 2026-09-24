/**
 * @packageDocumentation
 * @demlik/tea/paginate — the pagination batteries: the cursor walk as pure
 * state, and the resumable end-to-end traversal built over it.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/paginate/` and re-exported unchanged; nothing moved and
 * nothing was renamed to open it. The modules behind it:
 *
 * - `paginator` — the cursor / offset / page-token walk loop as pure state +
 *   ops, reading no clock and no I/O of its own.
 * - `paginated-walk` — traverse a paginated API or sitemap end to end, each
 *   page one keyed resilient call, resumable across an eviction.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 */

export * from "../internal/paginate/paginated-walk";
export * from "../internal/paginate/paginator";
