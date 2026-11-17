/** The durable log's bounded, immutable rule state. */
import type { DeliveryId } from "../../../pure/core";
import type {
  LoggedTimer,
  LogMessage,
  LogRead,
  LogRecord,
  PersistedLogRecord,
} from "../../../runtime-types";
import {
  applyEffectEvent,
  type EffectLedgerEvent,
  emptyLedger,
  foldLedger,
  type OwedEffect,
} from "./durable-effects";
import { type LogRefusal, ok, type Result } from "./refusals";

export type Admission<M> = PersistedLogRecord<LogMessage<M>>;
export type Birth<S, M, C> = Extract<LogRecord<S, M, C>, { _tag: "birth" }>;
export type SourceCommit<S, M, C> = Extract<
  LogRecord<S, M, C>,
  { _tag: "applied" | "receipt" }
>;

export type Projection<S, M, C> = {
  readonly version: number;
  readonly birth: boolean;
  readonly state: S | null;
  readonly storedState: unknown;
  readonly pending: readonly Admission<M>[];
  readonly owed: readonly OwedEffect<C>[];
  readonly high: DeliveryId;
  readonly applied: number;
  readonly baseline: number;
  readonly through: number;
  readonly snapshot: LogRead<S, M, C>["snapshot"];
  readonly timers: readonly LoggedTimer<M>[];
};

export function emptyProjection<S, M, C>(): Projection<S, M, C> {
  return {
    version: 0,
    birth: false,
    state: null,
    storedState: null,
    pending: [],
    owed: [],
    high: 0,
    applied: 0,
    baseline: 0,
    through: 0,
    snapshot: null,
    timers: [],
  };
}

export type CheckpointBoundary<S, M, C> = {
  readonly admission: Admission<M>;
  readonly committed: SourceCommit<S, M, C> | null;
  readonly appliedCount: number | null;
} | null;

export type CheckpointPosition = {
  readonly through: number;
  readonly snapshot: { readonly through: number } | null;
};
export type Checkpoint<S> = {
  readonly through: number;
  readonly state: S;
  readonly baseline: number;
};

export function checkpointEligibility<S, M, C>(
  position: CheckpointPosition,
  through: number,
  source: CheckpointBoundary<S, M, C>,
): Result<number | null> {
  if (
    !source?.committed ||
    source.appliedCount === null ||
    through > position.through
  )
    return { _tag: "invalid_checkpoint_boundary" };
  return ok(
    through < (position.snapshot?.through ?? 0) ? null : source.appliedCount,
  );
}

function checkpointFields<S>(checkpoint: Result<Checkpoint<S> | null>) {
  if (checkpoint._tag === "payload_rejected") return ok(null);
  if (checkpoint._tag !== "ok") return checkpoint;
  const accepted = checkpoint.value;
  return ok(
    accepted === null
      ? null
      : ({
          snapshot: { through: accepted.through, state: accepted.state },
          baseline: accepted.baseline,
        } as const),
  );
}

export function installCheckpoint<S, M, C>(
  p: Projection<S, M, C>,
  checkpoint: Result<Checkpoint<S> | null>,
): Projection<S, M, C> | LogRefusal {
  const fields = checkpointFields(checkpoint);
  if (fields._tag !== "ok") return fields;
  return fields.value === null ? p : { ...p, ...fields.value };
}

export type FoldInput<S, M, C> = {
  readonly row: PersistedLogRecord<LogRecord<S, M, C>>;
  readonly storedState: unknown;
  readonly stored: Admission<M> | null;
  readonly snapshot: unknown;
};

/** Deferred codec work: record rules must precede checkpoint parsing. */
export type FoldBoundary<S> = {
  readonly checkpointSource: (
    raw: unknown,
    position: CheckpointPosition,
  ) => Result<Checkpoint<S> | null>;
};

/** Fold a whole newly observed batch with one invocation-local accumulator. */
export function fold<S, M, C>(
  p: Projection<S, M, C>,
  inputs: Iterable<FoldInput<S, M, C> | LogRefusal>,
  boundary: FoldBoundary<S>,
): readonly [Projection<S, M, C>, readonly never[]] | LogRefusal {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  type Draft = Omit<Mutable<Projection<S, M, C>>, "pending" | "owed"> & {
    pending: Admission<M>[];
    cursor: number;
    owed: Map<DeliveryId, C>;
  };
  const draft: Draft = {
    ...p,
    pending: [...p.pending],
    cursor: 0,
    owed: new Map(p.owed.map(({ id, effect }) => [id, effect])),
  };

  const consume = (record: SourceCommit<S, M, C>): undefined | LogRefusal => {
    const source = draft.pending[draft.cursor];
    if (source?.record.id !== record.sourceId)
      return { _tag: "invalid_source_receipt" };
    draft.through = source.seq;
    draft.cursor += 1;
  };
  const ledger = (event: EffectLedgerEvent<C>): void => {
    const before = draft.owed.has(event.id)
      ? foldLedger([
          {
            _tag: "effect_owed",
            id: event.id,
            effect: draft.owed.get(event.id) as C,
          },
        ])
      : emptyLedger<C>();
    const after = applyEffectEvent(before, event);
    if (after.has(event.id)) draft.owed.set(event.id, after.get(event.id) as C);
    else draft.owed.delete(event.id);
  };
  const install = (
    record: Extract<LogRecord<S, M, C>, { _tag: "birth" | "applied" }>,
    storedState: unknown,
  ): undefined | LogRefusal => {
    for (const event of record.owed) {
      if (event.id <= draft.high) return { _tag: "invalid_delivery_ordering" };
      draft.high = event.id;
      ledger(event);
    }
    draft.state = record.state;
    draft.storedState = storedState;
    draft.timers = record.timers;
  };
  type Tag = LogRecord<S, M, C>["_tag"];
  type Table = {
    [K in Tag]: (
      input: Omit<FoldInput<S, M, C>, "row"> & {
        readonly row: PersistedLogRecord<
          Extract<LogRecord<S, M, C>, { _tag: K }>
        >;
      },
    ) => undefined | LogRefusal;
  };
  const foldCases = {
    birth: (input) => {
      if (draft.birth) return { _tag: "duplicate_birth_record" };
      draft.birth = true;
      return install(input.row.record, input.storedState);
    },
    message: (input) => {
      if (input.stored !== null) return { _tag: "duplicate_source" };
      draft.pending.push(input.row);
    },
    applied: (input) => {
      draft.applied += 1;
      const refusal = consume(input.row.record);
      if (refusal) return refusal;
      return install(input.row.record, input.storedState);
    },
    receipt: (input) => consume(input.row.record),
    confirmed: (input) => {
      if (!draft.owed.has(input.row.record.event.id))
        return { _tag: "invalid_delivery_receipt" };
      ledger(input.row.record.event);
    },
  } satisfies Table satisfies Record<Tag, Table[Tag]>;
  for (const input of inputs) {
    if ("_tag" in input) return input;
    const { seq, record } = input.row;
    if (seq !== draft.version + 1 || (seq === 1 && record._tag !== "birth"))
      return { _tag: "invalid_ordering" };
    const refusal = foldCases[record._tag](input as never);
    if (refusal) return refusal;
    draft.version = seq;
    if (input.snapshot !== null) {
      const checkpoint = checkpointFields(
        boundary.checkpointSource(input.snapshot, {
          through: draft.through,
          snapshot: draft.snapshot,
        }),
      );
      if (checkpoint._tag !== "ok") return checkpoint;
      if (checkpoint.value !== null) {
        Object.assign(draft, checkpoint.value);
      }
    }
  }
  const { cursor, ...rest } = draft;
  return [
    {
      ...rest,
      pending: draft.pending.slice(cursor),
      owed: [...draft.owed].map(([id, effect]) => ({ id, effect })),
    },
    [],
  ];
}
