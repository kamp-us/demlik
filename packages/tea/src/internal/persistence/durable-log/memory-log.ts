/** Memory's storage cache and synchronous write interpreter. */
import type { Cmd } from "../../../pure/core";
import {
  type EventSourcedOptions,
  type LoggedStore,
  type LogRecord,
  type LogStep,
  type PersistedLogRecord,
  schemaMigrate,
} from "../../../runtime-types";
import {
  type CheckpointMetadata,
  checkpointState,
  type DecodedFrame,
  decodeCheckpoint,
  decodeFrame,
  encodeCheckpoint,
  encodeFrame,
  integer,
} from "./codec";
import { logKey } from "./format";
import { decide, type Operation, response, type Write } from "./operations";
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
} from "./projection";
import {
  isRefusal,
  type LogRefusal,
  type Result,
  refusalMessage,
} from "./refusals";

export function memoryLog<S, M extends { _tag: string }, C extends Cmd>(
  backing: Map<string, string>,
  options: EventSourcedOptions<S, M, C>,
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
  const key = logKey(options.key);
  const every = options.snapshotEvery ?? 100;
  if (!Number.isSafeInteger(every) || every < 1)
    throw new Error("snapshotEvery must be a positive safe integer");
  let projection: Projection<S, M, C> = emptyProjection();
  let readModel = emptyModel();
  let root: string | undefined;
  let checkpointBytes: string | undefined;
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
    const stored = indexRecord(frame.row);
    return { ...frame, stored, snapshot: checkpointInput(frame.snapshot) };
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
  const read = (): void => {
    try {
      const current = backing.get(key);
      let initial: string | undefined;
      if (!loaded || current !== root) {
        projection = emptyProjection();
        readModel = emptyModel();
        root = current;
        checkpointBytes = undefined;
        loaded = true;
        initial = current;
        if (initial === undefined && backing.has(`${key}/2`))
          throw new Error("Durable log is missing its birth");
      }
      function* inputs(): Generator<FoldInput<S, M, C> | LogRefusal> {
        let next = projection.version + 1;
        if (initial !== undefined) {
          const frame = decodeFrame(initial, options);
          if (frame._tag !== "ok") {
            yield frame;
            return;
          }
          yield add(frame.value);
          next = 2;
        }
        for (;;) {
          const bytes = backing.get(`${key}/${next}`);
          if (bytes === undefined) break;
          const frame = decodeFrame(bytes, options);
          if (frame._tag !== "ok") {
            yield frame;
            return;
          }
          yield add(frame.value);
          next += 1;
        }
      }
      apply(inputs());
      const saved = backing.get(`${key}/checkpoint`);
      if (saved !== checkpointBytes) {
        if (saved !== undefined) acceptCheckpoint(saved);
        checkpointBytes = saved;
      }
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
  const mutate = <K extends Input["_tag"]>(
    input: Input & { readonly _tag: K },
  ) => {
    read();
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
    const persist = (suffix: string, bytes: string): void => {
      writeStarted = true;
      backing.set(key + suffix, bytes);
    };
    const interpreters = {
      append_record: (
        write: Extract<Write<S, M, C>, { _tag: "append_record" }>,
      ) => {
        const frame = requireValue(
          encodeFrame(
            write.record,
            projection.version + 1,
            write.checkpointThrough,
            options,
          ),
        );
        stored = frame.row;
        // A native response-clone failure must leave storage untouched.
        prepared = prepareResponse(stored);
        persist(stored.seq === 1 ? "" : `/${stored.seq}`, frame.bytes);
        apply([add(frame)]);
        if (stored.seq === 1) root = frame.bytes;
      },
      write_checkpoint: (
        write: Extract<Write<S, M, C>, { _tag: "write_checkpoint" }>,
      ) => {
        const bytes = encodeCheckpoint(write.through, write.storedState);
        persist("/checkpoint", bytes);
        acceptCheckpoint(bytes);
        checkpointBytes = bytes;
      },
    } satisfies {
      [K in Write<S, M, C>["_tag"]]: (
        write: Extract<Write<S, M, C>, { _tag: K }>,
      ) => void;
    };
    try {
      for (const write of writes) interpreters[write._tag](write as never);
      return prepared ?? prepareResponse(stored);
    } catch (error) {
      if (writeStarted) loaded = false;
      throw error;
    }
  };
  const store: LoggedStore<S, M, C> = {
    logged: true,
    async load() {
      read();
      return structuredClone(projection.state);
    },
    async save() {
      throw new Error("Logged State can only change through commitStep");
    },
    migrate: schemaMigrate(options.state),
    async readLog() {
      read();
      return structuredClone({
        version: projection.version,
        records: readModel.records,
        snapshot: projection.snapshot,
        timers: projection.timers,
      });
    },
    async appendMessage(message) {
      return mutate({ _tag: "append_message", message });
    },
    async commitStep(step) {
      return mutate(step);
    },
    async confirmEffect(id) {
      return mutate({ _tag: "confirm_effect", id });
    },
    async checkpoint() {
      return mutate({ _tag: "checkpoint" });
    },
  };
  return {
    store,
    inspect: () => {
      read();
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
