/**
 * @packageDocumentation
 * @demlik/tea/persistence — the durability batteries: record a run to a trace,
 * replay that trace back, and checkpoint a long-running machine to a host
 * store between evictions.
 *
 * The persistence operations live under `src/internal/persistence/`.
 * Journal contract aliases expose the storage door from `src/internal/journal/`
 * without copying its shape. The persistence modules behind this entry:
 *
 * - `log-store` — compose a journal and schemas into the engine-facing durable log.
 * - `recorder` — capture a run as a `Trace` (plus breadcrumbs and
 *   attachments), sufficient to reproduce it.
 * - `row-store` — a fenced Store over one SQL row.
 * - `snapshot` — periodic state checkpoint to a host store, so a long-running
 *   machine resumes from its last checkpoint rather than from the top.
 * - `trace-replay` — feed a recorded `Trace` back through a machine and report
 *   where, if anywhere, the replay diverged.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 */

export { eventSourcedStore } from "../internal/persistence/log-store";
export * from "../internal/persistence/recorder";
export {
  type RowPort,
  type RowStoreOptions,
  rowStore,
} from "../internal/persistence/row-store";
export * from "../internal/persistence/snapshot";
export * from "../internal/persistence/trace-replay";

import type * as JournalContract from "../internal/journal";

/** Ordered storage of opaque text in atomic batches.
 * @experimental
 */
export type Journal = JournalContract.Journal;
/** A journal with an explicit expected-head append capability.
 * @experimental
 */
export type FencedJournal = JournalContract.FencedJournal;
/** Opaque text and the position assigned by its journal.
 * @experimental
 */
export type JournalEntry = JournalContract.JournalEntry;
/** A stream's head and the entries after a requested position.
 * @experimental
 */
export type JournalRead = JournalContract.JournalRead;
/** Acknowledged text and positions from one atomic append.
 * @experimental
 */
export type JournalAppend = JournalContract.JournalAppend;
/** Storage failure data, preserving append uncertainty.
 * @experimental
 */
export type JournalRefusal = JournalContract.JournalRefusal;
/** An expected-head mismatch that changed no storage.
 * @experimental
 */
export type JournalConflict = JournalContract.JournalConflict;
/** Opaque well-formed Unicode text preserved exactly by a driver.
 * @experimental
 */
export type EncodedRecord = JournalContract.EncodedRecord;
