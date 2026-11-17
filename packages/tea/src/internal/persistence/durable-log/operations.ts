/** Pure decisions describe writes; responses use the decoded acknowledgement. */
import type { DeliveryId } from "../../../pure/core";
import type {
  LogAppend,
  LogCommit,
  LogConfirmation,
  LogMessage,
  LogRecord,
  LogStep,
  PersistedLogRecord,
} from "../../../runtime-types";
import { pendingEffectsLedger } from "./durable-effects";
import type { Admission, Birth, Projection, SourceCommit } from "./projection";
import type { LogRefusal } from "./refusals";

export type Operation<S, M, C> =
  | {
      readonly _tag: "append_message";
      readonly message: LogMessage<M>;
      readonly stored: Admission<M> | null;
    }
  | {
      readonly _tag: "birth";
      readonly step: Extract<LogStep<S, M, C>, { _tag: "birth" }>;
      readonly committed: Birth<S, M, C> | null;
    }
  | {
      readonly _tag: "applied";
      readonly step: Extract<LogStep<S, M, C>, { _tag: "applied" }>;
      readonly committed: SourceCommit<S, M, C> | null;
    }
  | {
      readonly _tag: "receipt";
      readonly step: Extract<LogStep<S, M, C>, { _tag: "receipt" }>;
      readonly committed: SourceCommit<S, M, C> | null;
    }
  | { readonly _tag: "confirm_effect"; readonly id: DeliveryId }
  | { readonly _tag: "checkpoint" };
export type Write<S, M, C> =
  | {
      readonly _tag: "append_record";
      readonly record: LogRecord<S, M, C>;
      readonly checkpointThrough: number | null;
    }
  | {
      readonly _tag: "write_checkpoint";
      readonly through: number;
      readonly storedState: unknown;
    };
export type Verb<S, M, C> =
  | readonly [Projection<S, M, C>, readonly Write<S, M, C>[]]
  | LogRefusal;
export type Policy = { readonly snapshotEvery: number };

type Replies<S, M, C> = {
  readonly append_message: LogAppend<M>;
  readonly birth: LogCommit<S, C>;
  readonly applied: LogCommit<S, C>;
  readonly receipt: LogCommit<S, C>;
  readonly confirm_effect: LogConfirmation;
  readonly checkpoint: boolean;
};
type Tag = Operation<unknown, unknown, unknown>["_tag"];
type Table<S, M, C> = {
  [K in Tag]: {
    readonly decide: (
      p: Projection<S, M, C>,
      op: Extract<Operation<S, M, C>, { _tag: K }>,
      policy: Policy,
    ) => Verb<S, M, C>;
    readonly response: (
      p: Projection<S, M, C>,
      op: Extract<Operation<S, M, C>, { _tag: K }>,
      stored: PersistedLogRecord<LogRecord<S, M, C>> | null,
      writes: readonly Write<S, M, C>[],
    ) => Replies<S, M, C>[K] | LogRefusal;
  };
};

type RecordCases<S, M, C, R> = {
  [K in LogRecord<S, M, C>["_tag"]]: (
    record: Extract<LogRecord<S, M, C>, { _tag: K }>,
  ) => R;
};

const invalidCommitment = (): LogRefusal => ({
  _tag: "invalid_committed_record",
});

function committed<S, M, C>(
  record: LogRecord<S, M, C> | null,
  p: Projection<S, M, C>,
  version: number,
): LogCommit<S, C> | LogRefusal {
  if (record === null) return invalidCommitment();
  const withState = (
    r: Birth<S, M, C> | Extract<LogRecord<S, M, C>, { _tag: "applied" }>,
  ): LogCommit<S, C> => ({
    version,
    state: r.state,
    owed: r.owed.map(({ id, effect }) => ({ id, effect })),
  });
  const readers = {
    birth: withState,
    applied: withState,
    receipt: (): LogCommit<S, C> => ({
      version,
      state: p.state as S,
      owed: [],
    }),
    message: invalidCommitment,
    confirmed: invalidCommitment,
  } satisfies RecordCases<S, M, C, LogCommit<S, C> | LogRefusal>;
  return readers[record._tag](record as never);
}

function appended<S, M, C>(
  stored: PersistedLogRecord<LogRecord<S, M, C>> | null,
): LogAppend<M> | LogRefusal {
  if (stored === null) return invalidCommitment();
  const readers = {
    birth: invalidCommitment,
    message: (record) => ({
      version: stored.seq,
      appended: true,
      entry: { seq: stored.seq, record },
    }),
    applied: invalidCommitment,
    receipt: invalidCommitment,
    confirmed: invalidCommitment,
  } satisfies RecordCases<S, M, C, LogAppend<M> | LogRefusal>;
  return readers[stored.record._tag](stored.record as never);
}

function cases<S, M, C>(): Table<S, M, C> {
  const owe = (p: Projection<S, M, C>, cmds: readonly C[]) => {
    const recorder = pendingEffectsLedger<C>({ lastId: p.high });
    return cmds.map((cmd) => recorder.owe(cmd).event);
  };
  const source = (p: Projection<S, M, C>, sourceId: string) =>
    p.pending[0]?.record.id === sourceId ? p.pending[0] : null;
  const commitment = (
    p: Projection<S, M, C>,
    op: { readonly committed: Birth<S, M, C> | SourceCommit<S, M, C> | null },
    stored: PersistedLogRecord<LogRecord<S, M, C>> | null,
  ) =>
    committed(
      op.committed ?? stored?.record ?? null,
      p,
      stored?.seq ?? p.version,
    );
  const operationCases = {
    append_message: {
      decide: (p, op) => {
        if (!p.birth) return { _tag: "admission_before_birth" };
        return [
          p,
          op.stored === null
            ? [
                {
                  _tag: "append_record",
                  record: op.message,
                  checkpointThrough: null,
                },
              ]
            : [],
        ];
      },
      response: (p, op, stored) => {
        if (op.stored !== null)
          return { version: p.version, appended: false, entry: op.stored };
        return appended(stored);
      },
    },
    birth: {
      decide: (p, op) => {
        if (op.committed !== null) return [p, []];
        if (p.version !== 0) return { _tag: "birth_on_nonempty_log" };
        return [
          p,
          [
            {
              _tag: "append_record",
              record: {
                _tag: "birth",
                at: op.step.at,
                state: op.step.state,
                owed: owe(p, op.step.cmds),
                timers: op.step.timers,
              },
              checkpointThrough: null,
            },
          ],
        ];
      },
      response: commitment,
    },
    applied: {
      decide: (p, op, policy) => {
        if (op.committed !== null) return [p, []];
        const admission = source(p, op.step.sourceId);
        if (admission === null) return { _tag: "not_first_pending_source" };
        return [
          p,
          [
            {
              _tag: "append_record",
              record: {
                _tag: "applied",
                sourceId: op.step.sourceId,
                state: op.step.state,
                owed: owe(p, op.step.cmds),
                timers: op.step.timers,
              },
              checkpointThrough:
                p.applied + 1 - p.baseline >= policy.snapshotEvery
                  ? admission.seq
                  : null,
            },
          ],
        ];
      },
      response: commitment,
    },
    receipt: {
      decide: (p, op) => {
        if (op.committed !== null) return [p, []];
        if (source(p, op.step.sourceId) === null)
          return { _tag: "not_first_pending_source" };
        return [
          p,
          [
            {
              _tag: "append_record",
              record: {
                _tag: "receipt",
                sourceId: op.step.sourceId,
                disposition: op.step.disposition,
                ...(op.step.failure ? { failure: op.step.failure } : {}),
              },
              checkpointThrough: null,
            },
          ],
        ];
      },
      response: commitment,
    },
    confirm_effect: {
      decide: (p, op) => [
        p,
        p.owed.some(({ id }) => id === op.id)
          ? [
              {
                _tag: "append_record",
                record: {
                  _tag: "confirmed",
                  event: { _tag: "effect_confirmed", id: op.id },
                },
                checkpointThrough: null,
              },
            ]
          : [],
      ],
      response: (p, _op, stored) => ({
        version: stored?.seq ?? p.version,
        confirmed: stored !== null,
      }),
    },
    checkpoint: {
      decide: (p) => [
        p,
        p.applied === p.baseline || !p.birth
          ? []
          : [
              {
                _tag: "write_checkpoint",
                through: p.through,
                storedState: p.storedState,
              },
            ],
      ],
      response: (_p, _op, _stored, writes) => writes.length !== 0,
    },
  } satisfies Table<S, M, C> satisfies Record<Tag, Table<S, M, C>[Tag]>;
  return operationCases;
}

export function decide<S, M, C>(
  p: Projection<S, M, C>,
  op: Operation<S, M, C>,
  policy: Policy,
): Verb<S, M, C> {
  return cases<S, M, C>()[op._tag].decide(p, op as never, policy);
}

export function response<S, M, C, K extends Tag>(
  p: Projection<S, M, C>,
  op: Operation<S, M, C> & { readonly _tag: K },
  stored: PersistedLogRecord<LogRecord<S, M, C>> | null,
  writes: readonly Write<S, M, C>[],
): Replies<S, M, C>[K] | LogRefusal {
  return cases<S, M, C>()[op._tag].response(p, op as never, stored, writes);
}
