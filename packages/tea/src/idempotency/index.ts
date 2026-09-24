/**
 * @packageDocumentation
 * @demlik/tea/idempotency — do-it-once: dedupe by key, cache the result, and
 * replay that result to every duplicate arrival.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/idempotency/` and re-exported unchanged; nothing moved and
 * nothing was renamed to open it. The modules behind it:
 *
 * - `idempotency` — dedupe-by-key + last-result cache as pure state + ops.
 * - `idempotent-intake` — receive-once intake for webhooks / queue messages:
 *   dedupe by key, enqueue the new ones, replay the cached result to the rest.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 */

export * from "../internal/idempotency/idempotency";
export * from "../internal/idempotency/idempotent-intake";
