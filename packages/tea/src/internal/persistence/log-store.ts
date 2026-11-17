/** Journal I/O boundary for the pure durable-log rules. */

import type { Cmd } from "../../pure/core";
import {
  type EventSourcedOptions,
  type FencedStore,
  type LoggedStore,
  type LogRecord,
  type LogStep,
  type PersistedLogRecord,
  StoreConflictError,
  schemaMigrate,
} from "../../runtime-types";
import type {
  FencedJournal,
  Journal,
  JournalAppend,
  JournalConflict,
  JournalEntry,
  JournalRead,
  JournalRefusal,
} from "../journal";
import {
  type CheckpointMetadata,
  checkpointState,
  type DecodedFrame,
  decodeCheckpoint,
  decodeFrame,
  encodeCheckpoint,
  encodeFrame,
  integer,
} from "./durable-log/codec";

import {
  decide,
  type Operation,
  response,
  type Write,
} from "./durable-log/operations";
import {
  type Admission,
  type Birth,
  type CheckpointBoundary,
  type CheckpointInput,
  emptyProjection,
  type FoldBoundary,
  type FoldInput,
  fold,
  installCheckpoint,
  type Projection,
  type SourceCommit,
} from "./durable-log/projection";
import {
  isRefusal,
  type LogRefusal,
  type Result,
  refusalMessage,
} from "./durable-log/refusals";

export function createLogStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: Journal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced?: boolean },
) {
  type Row = PersistedLogRecord<LogRecord<S, M, C>>;
  type SourcePlace = {
    readonly admission: number;
    readonly commit: number | null;
    readonly appliedCount: number | null;
  };
  type ReadModel = {
    records: Row[];
    places: Map<string, SourcePlace>;
    appliedCount: number;
  };
  const emptyModel = (): ReadModel => ({
    records: [],
    places: new Map(),
    appliedCount: 0,
  });
  const key = JSON.stringify([options.key ?? "default", "log"]);
  const checkpointKey = JSON.stringify([
    options.key ?? "default",
    "checkpoint",
  ]);
  const every = options.snapshotEvery ?? 100;
  if (!Number.isSafeInteger(every) || every < 1)
    throw new Error("snapshotEvery must be a positive safe integer");
  let projection: Projection<S, M, C> = emptyProjection();
  let readModel = emptyModel();
  let checkpointHead = 0;
  let checkpointText: string | undefined;
  let expected: number | undefined;
  let expectedCheckpoint: number | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(use: () => Promise<T>): Promise<T> => {
    const next = tail.then(use);
    tail = next.catch(() => {});
    return next;
  };
  let loaded = false;

  const requireValue = <T>(result: Result<T>): T => {
    if (result._tag !== "ok") throw new Error(refusalMessage(result));
    return result.value;
  };
  const requireVerb = <T>(result: T | LogRefusal): T => {
    if (isRefusal(result)) throw new Error(refusalMessage(result));
    return result;
  };
  const admissionAt = (seq: number): Admission<M> | null => {
    const row = readModel.records[seq - 1];
    return row?.record._tag === "message"
      ? { seq: row.seq, record: row.record }
      : null;
  };
  const sourceCommitAt = (seq: number | null): SourceCommit<S, M, C> | null => {
    const record =
      seq === null ? undefined : readModel.records[seq - 1]?.record;
    return record?._tag === "applied" || record?._tag === "receipt"
      ? record
      : null;
  };
  const checkpointSource = (through: number): CheckpointBoundary<S, M, C> => {
    const admission = admissionAt(through);
    if (admission === null) return null;
    const place = readModel.places.get(admission.record.id);
    return place === undefined
      ? null
      : {
          admission,
          committed: sourceCommitAt(place.commit),
          appliedCount: place.appliedCount,
        };
  };
  const boundary: FoldBoundary<S> = {
    decodeCheckpointState: (rawState) =>
      checkpointState(rawState, options.state),
  };
  const checkpointInput = (
    metadata: CheckpointMetadata | null,
  ): CheckpointInput<S, M, C> | null =>
    metadata === null
      ? null
      : { ...metadata, source: checkpointSource(metadata.through) };

  const indexRecord = (row: Row): Admission<M> | null => {
    type Cases = {
      [K in LogRecord<S, M, C>["_tag"]]: (
        record: Extract<LogRecord<S, M, C>, { _tag: K }>,
      ) => Admission<M> | null;
    };
    const commitment = (record: SourceCommit<S, M, C>): null => {
      const place = readModel.places.get(record.sourceId);
      if (place !== undefined)
        readModel.places.set(record.sourceId, {
          ...place,
          commit: row.seq,
          appliedCount: readModel.appliedCount,
        });
      return null;
    };
    const index = {
      birth: () => null,
      message: (record) => {
        const previous = readModel.places.get(record.id);
        readModel.places.set(record.id, {
          admission: row.seq,
          commit: null,
          appliedCount: null,
        });
        return previous === undefined ? null : admissionAt(previous.admission);
      },
      applied: (record) => {
        readModel.appliedCount += 1;
        return commitment(record);
      },
      receipt: commitment,
      confirmed: () => null,
    } satisfies Cases;
    const previous = index[row.record._tag](row.record as never);
    readModel.records.push(row);
    return previous;
  };
  const add = (frame: DecodedFrame<S, M, C>): FoldInput<S, M, C> => {
    const input = {
      row: frame.row,
      storedState: frame.storedState,
      stored: indexRecord(frame.row),
    };
    if (frame.snapshot._tag !== "ok")
      return { ...input, snapshot: null, checkpointRefusal: frame.snapshot };
    return { ...input, snapshot: checkpointInput(frame.snapshot.value) };
  };
  const apply = (inputs: Iterable<FoldInput<S, M, C> | LogRefusal>): void => {
    [projection] = requireVerb(fold(projection, inputs, boundary));
  };
  const acceptCheckpoint = (bytes: string): void => {
    const checkpoint = checkpointInput(requireValue(decodeCheckpoint(bytes)));
    projection = requireVerb(
      installCheckpoint(projection, checkpoint, boundary),
    );
  };
  const edge = (refusal: JournalRefusal | JournalConflict): never => {
    if (refusal._tag === "journal_conflict") {
      const error = new StoreConflictError(refusal.expected, refusal.head);
      Object.assign(error, { cause: refusal, uncertain: false });
      throw error;
    }
    throw new Error(refusal.message, { cause: refusal });
  };
  const accept = (entries: readonly JournalEntry[]): void => {
    function* inputs(): Generator<FoldInput<S, M, C> | LogRefusal> {
      for (const entry of entries) {
        const frame = decodeFrame(entry.record, options);
        if (frame._tag !== "ok") {
          yield frame;
          return;
        }
        if (frame.value.row.seq !== entry.seq) {
          yield { _tag: "invalid_ordering" };
          return;
        }
        yield add(frame.value);
      }
    }
    apply(inputs());
  };
  const reset = (): void => {
    projection = emptyProjection();
    readModel = emptyModel();
    checkpointHead = 0;
    checkpointText = undefined;
    loaded = true;
  };
  const read = async (): Promise<void> => {
    if (loaded) return;
    try {
      reset();
      const current = await journal.read(key, projection.version);
      if (current._tag !== "read") edge(current);
      const read = current as JournalRead;
      expected = read.head;
      accept(read.entries);
      const checkpoint = await journal.read(checkpointKey, checkpointHead);
      if (checkpoint._tag !== "read") edge(checkpoint);
      const saved = checkpoint as JournalRead;
      expectedCheckpoint = saved.head;
      for (const entry of saved.entries) {
        acceptCheckpoint(entry.record);
        checkpointText = entry.record;
      }
      checkpointHead = saved.head;
    } catch (error) {
      loaded = false;
      throw error;
    }
  };

  type Input =
    | LogStep<S, M, C>
    | Extract<Operation<S, M, C>, { _tag: "confirm_effect" | "checkpoint" }>
    | Omit<Extract<Operation<S, M, C>, { _tag: "append_message" }>, "stored">;
  const operation = (input: Input): Operation<S, M, C> => {
    type Cases = {
      [K in Input["_tag"]]: (
        input: Extract<Input, { _tag: K }>,
      ) => Operation<S, M, C>;
    };
    const sourceCommit = (sourceId: string): SourceCommit<S, M, C> | null => {
      const place = readModel.places.get(sourceId);
      return sourceCommitAt(place?.commit ?? null);
    };
    const facts = {
      append_message: (op) => {
        const place = readModel.places.get(op.message.id);
        return {
          _tag: "append_message",
          message: op.message,
          stored: place === undefined ? null : admissionAt(place.admission),
        };
      },
      birth: (step) => {
        const record = readModel.records[0]?.record;
        const committed: Birth<S, M, C> | null =
          record?._tag === "birth" ? record : null;
        return { _tag: "birth", step, committed };
      },
      applied: (step) => ({
        _tag: "applied",
        step,
        committed: sourceCommit(step.sourceId),
      }),
      receipt: (step) => ({
        _tag: "receipt",
        step,
        committed: sourceCommit(step.sourceId),
      }),
      confirm_effect: (op) => ({
        _tag: "confirm_effect",
        id: requireValue(integer(op.id, 1)),
      }),
      checkpoint: (op) => op,
    } satisfies Cases;
    return facts[input._tag](input as never);
  };
  const mutate = async <K extends Input["_tag"]>(
    input: Input & { readonly _tag: K },
  ) => {
    await read();
    const before = projection;
    const op = operation(input) as Operation<S, M, C> & { readonly _tag: K };
    const [, writes] = requireVerb(
      decide(projection, op, { snapshotEvery: every }),
    );
    let stored: Row | null = null;
    const prepareResponse = (row: Row | null) =>
      structuredClone(
        requireVerb(response<S, M, C, K>(before, op, row, writes)),
      );
    let prepared: ReturnType<typeof prepareResponse> | undefined;
    let writeStarted = false;
    type Plan = {
      readonly stream: string;
      readonly bytes: string;
      readonly expected: number;
      readonly acknowledge: (ack: JournalAppend) => void;
    };
    const interpreters = {
      append_record: (
        write: Extract<Write<S, M, C>, { _tag: "append_record" }>,
      ): Plan => {
        const frame = requireValue(
          encodeFrame(
            write.record,
            projection.version + 1,
            write.checkpointThrough,
            options,
          ),
        );
        prepared = prepareResponse(frame.row);
        return {
          stream: key,
          bytes: frame.bytes,
          expected: expected ?? 0,
          acknowledge(ack) {
            expected = ack.head;
            accept(ack.entries);
            stored = readModel.records.at(-1) ?? null;
            prepared = undefined;
          },
        };
      },
      write_checkpoint: (
        write: Extract<Write<S, M, C>, { _tag: "write_checkpoint" }>,
      ): Plan => ({
        stream: checkpointKey,
        bytes: encodeCheckpoint(write.through, write.storedState),
        expected: expectedCheckpoint ?? 0,
        acknowledge(ack) {
          expectedCheckpoint = ack.head;
          for (const entry of ack.entries) {
            acceptCheckpoint(entry.record);
            checkpointText = entry.record;
          }
          checkpointHead = ack.head;
        },
      }),
    } satisfies Record<Write<S, M, C>["_tag"], (write: never) => Plan>;

    try {
      const plans = writes.map((write) =>
        interpreters[write._tag](write as never),
      );
      const first = plans[0];
      if (first) {
        // Current pure verbs produce at most one write; the batch remains the unit of I/O.
        if (plans.some((plan) => plan.stream !== first.stream))
          throw new Error("Write crosses streams");
        const batch: [string, ...string[]] = [
          first.bytes,
          ...plans.slice(1).map((plan) => plan.bytes),
        ];
        writeStarted = true;
        const ack =
          options.fenced === true
            ? await (journal as FencedJournal).appendFenced(
                first.stream,
                batch,
                first.expected,
              )
            : await journal.append(first.stream, batch);
        if (ack._tag !== "appended") edge(ack);
        if (ack._tag !== "appended") throw new Error("unreachable");
        first.acknowledge(ack);
      }
      return prepared ?? prepareResponse(stored);
    } catch (error) {
      if (writeStarted) loaded = false;
      throw error;
    }
  };

  const store: LoggedStore<S, M, C> = {
    logged: true,
    load() {
      return serial(async () => {
        await read();
        return structuredClone(projection.state);
      });
    },
    async save() {
      throw new Error("Logged State can only change through commitStep");
    },
    migrate: schemaMigrate(options.state),
    readLog() {
      return serial(async () => {
        await read();
        return structuredClone({
          version: projection.version,
          records: readModel.records,
          snapshot: projection.snapshot,
          timers: projection.timers,
        });
      });
    },
    async appendMessage(message) {
      return serial(() => mutate({ _tag: "append_message", message }));
    },
    async commitStep(step) {
      return serial(() => mutate(step));
    },
    async confirmEffect(id) {
      return serial(() => mutate({ _tag: "confirm_effect", id }));
    },
    async checkpoint() {
      return serial(() => mutate({ _tag: "checkpoint" }));
    },
  };
  return {
    store:
      options.fenced === true
        ? Object.assign(store, {
            fenced: true as const,
            loadFenced() {
              return serial(async () => {
                await read();
                return {
                  raw: structuredClone(projection.state),
                  version: projection.version,
                };
              });
            },
            async saveFenced() {
              throw new Error(
                "Logged State can only change through commitStep",
              );
            },
          })
        : store,
    // Trusted synchronous fixture inspection shares this decoder and index, never a second reader.
    inspect: (seed?: {
      entries: readonly JournalEntry[];
      checkpoint?: string;
      checkpointHead?: number;
    }) => {
      if (seed) {
        const rebuilding = !loaded;
        try {
          if (rebuilding) reset();
          accept(
            seed.entries.filter((entry) => entry.seq > projection.version),
          );
          if (seed.checkpoint && seed.checkpoint !== checkpointText) {
            acceptCheckpoint(seed.checkpoint);
            checkpointText = seed.checkpoint;
          }
          checkpointHead = seed.checkpointHead ?? 0;
          if (rebuilding) {
            expected = projection.version;
            expectedCheckpoint = checkpointHead;
          }
        } catch (error) {
          loaded = false;
          throw error;
        }
      }
      return structuredClone({ projection, readModel }) as {
        readonly projection: Projection<S, M, C>;
        readonly readModel: {
          readonly records: readonly Row[];
          readonly places: ReadonlyMap<string, SourcePlace>;
          readonly appliedCount: number;
        };
      };
    },
  };
}

/**
 * Plain journal-backed stores require one active writer per stream throughout the loaded activation; concurrent plain writers can corrupt history.
 *
 * Build an engine-facing durable log from opaque journal storage and schemas.
 * Opt into fencing explicitly with a FencedJournal and `{ fenced: true }`.
 * The caller owns the journal and closes it after the activation ends.
 *
 * @experimental
 */
export function eventSourcedStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: FencedJournal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced: true },
): LoggedStore<S, M, C> & FencedStore<S>;
export function eventSourcedStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: Journal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced?: false },
): LoggedStore<S, M, C>;
export function eventSourcedStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: Journal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced?: boolean },
): LoggedStore<S, M, C> | (LoggedStore<S, M, C> & FencedStore<S>) {
  return createLogStore(journal, options).store;
}
