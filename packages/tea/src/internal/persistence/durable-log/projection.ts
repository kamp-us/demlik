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
  type EffectConfirmed,
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
export type CheckpointInput<S, M, C> = {
  readonly through: number;
  readonly rawState: unknown;
  readonly source: CheckpointBoundary<S, M, C>;
};

export type CheckpointState<S> =
  | { readonly _tag: "state_rejected" }
  | { readonly _tag: "decoded"; readonly state: S };

export type FoldBoundary<S> = {
  readonly decodeCheckpointState: (rawState: unknown) => CheckpointState<S>;
};

export type CheckpointOutcome<S> =
  | { readonly _tag: "skipped" }
  | { readonly _tag: "state_rejected" }
  | {
      readonly _tag: "decoded";
      readonly through: number;
      readonly state: S;
      readonly baseline: number;
    };

type CheckpointFields<S> = {
  readonly snapshot: { readonly through: number; readonly state: S };
  readonly baseline: number;
};

type CheckpointCases<S> = {
  [K in CheckpointOutcome<S>["_tag"]]: (
    outcome: Extract<CheckpointOutcome<S>, { _tag: K }>,
  ) => CheckpointFields<S> | null;
};

const keep = () => null;
export const checkpointCases = {
  skipped: keep,
  state_rejected: keep,
  decoded: <S>(
    outcome: Extract<CheckpointOutcome<S>, { _tag: "decoded" }>,
  ) => ({
    snapshot: { through: outcome.through, state: outcome.state },
    baseline: outcome.baseline,
  }),
} satisfies CheckpointCases<unknown>;

function checkpointEligibility<S, M, C>(
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

function checkpointOutcome<S, M, C>(
  position: CheckpointPosition,
  checkpoint: CheckpointInput<S, M, C> | null,
  boundary: FoldBoundary<S>,
): Result<CheckpointOutcome<S>> {
  if (checkpoint === null) return ok({ _tag: "skipped" });
  const eligible = checkpointEligibility(
    position,
    checkpoint.through,
    checkpoint.source,
  );
  if (eligible._tag !== "ok") return eligible;
  if (eligible.value === null) return ok({ _tag: "skipped" });
  return ok({
    ...boundary.decodeCheckpointState(checkpoint.rawState),
    through: checkpoint.through,
    baseline: eligible.value,
  });
}

function checkpointFields<S, M, C>(
  position: CheckpointPosition,
  checkpoint: CheckpointInput<S, M, C> | null,
  boundary: FoldBoundary<S>,
): Result<CheckpointFields<S> | null> {
  const outcome = checkpointOutcome(position, checkpoint, boundary);
  if (outcome._tag !== "ok") return outcome;
  return ok(checkpointCases[outcome.value._tag](outcome.value as never));
}

export function installCheckpoint<S, M, C>(
  p: Projection<S, M, C>,
  checkpoint: CheckpointInput<S, M, C> | null,
  boundary: FoldBoundary<S>,
): Projection<S, M, C> | LogRefusal {
  const fields = checkpointFields(p, checkpoint, boundary);
  if (fields._tag !== "ok") return fields;
  return fields.value === null ? p : { ...p, ...fields.value };
}

export type FoldInput<S, M, C> = {
  readonly row: PersistedLogRecord<LogRecord<S, M, C>>;
  readonly storedState: unknown;
  readonly stored: Admission<M> | null;
  readonly snapshot: CheckpointInput<S, M, C> | null;
  /** Metadata is parsed eagerly, but a record refusal takes precedence. */
  readonly checkpointRefusal?: LogRefusal;
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
  const confirm = (event: EffectConfirmed): undefined | LogRefusal => {
    if (!draft.owed.has(event.id)) return { _tag: "invalid_delivery_receipt" };
    ledger(event);
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
    [K in Tag]: {
      readonly first: boolean;
      readonly fold: (
        input: Omit<FoldInput<S, M, C>, "row"> & {
          readonly row: PersistedLogRecord<
            Extract<LogRecord<S, M, C>, { _tag: K }>
          >;
        },
      ) => undefined | LogRefusal;
    };
  };
  const foldCases = {
    birth: {
      first: true,
      fold: (input) => {
        if (draft.birth) return { _tag: "duplicate_birth_record" };
        draft.birth = true;
        return install(input.row.record, input.storedState);
      },
    },
    message: {
      first: false,
      fold: (input) => {
        if (input.stored !== null) return { _tag: "duplicate_source" };
        const answerTo = input.row.record.answerTo;
        if (answerTo !== undefined) {
          const refusal = confirm({ _tag: "effect_confirmed", id: answerTo });
          if (refusal) return refusal;
        }
        draft.pending.push(input.row);
      },
    },
    applied: {
      first: false,
      fold: (input) => {
        draft.applied += 1;
        const refusal = consume(input.row.record);
        if (refusal) return refusal;
        return install(input.row.record, input.storedState);
      },
    },
    receipt: {
      first: false,
      fold: (input) => consume(input.row.record),
    },
    confirmed: {
      first: false,
      fold: (input) => confirm(input.row.record.event),
    },
  } satisfies Table satisfies Record<Tag, Table[Tag]>;
  for (const input of inputs) {
    if ("_tag" in input) return input;
    const { seq, record } = input.row;
    const row = foldCases[record._tag];
    if (seq !== draft.version + 1 || (seq === 1 && !row.first))
      return { _tag: "invalid_ordering" };
    const refusal = row.fold(input as never);
    if (refusal) return refusal;
    draft.version = seq;
    if (input.checkpointRefusal) return input.checkpointRefusal;
    if (input.snapshot !== null) {
      const checkpoint = checkpointFields(draft, input.snapshot, boundary);
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
