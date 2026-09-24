/**
 * @packageDocumentation
 * @demlik/tea/persistence — the durability batteries: record a run to a trace,
 * replay that trace back, and checkpoint a long-running machine to a host
 * store between evictions.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/persistence/` and re-exported unchanged; nothing moved and
 * nothing was renamed to open it. The modules behind it:
 *
 * - `recorder` — capture a run as a `Trace` (plus breadcrumbs and
 *   attachments), sufficient to reproduce it.
 * - `snapshot` — periodic state checkpoint to a host store, so a long-running
 *   machine resumes from its last checkpoint rather than from the top.
 * - `trace-replay` — feed a recorded `Trace` back through a machine and report
 *   where, if anywhere, the replay diverged.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 */

export * from "../internal/persistence/recorder";
export * from "../internal/persistence/snapshot";
export * from "../internal/persistence/trace-replay";
