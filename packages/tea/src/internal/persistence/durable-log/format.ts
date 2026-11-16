/** The neutral serialized log format and its pure write decisions. */

import type { DeliveryId } from "../../../pure/core";
import type {
  EventSourcedOptions,
  LogAppend,
  LogCommit,
  LogConfirmation,
  LoggedTimer,
  LogMessage,
  LogRead,
  LogRecord,
  LogStep,
  PersistedLogRecord,
  Schema,
} from "../../../runtime-types";
import type { EffectLedgerEvent, EffectOwed } from "./durable-effects";
import { pendingEffectsLedger } from "./durable-effects";

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Invalid durable log object");
  return raw as Record<string, unknown>;
}
function integer(raw: unknown, min = 0): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min)
    throw new Error("Invalid durable log integer");
  return raw;
}
function number(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw))
    throw new Error("Invalid durable log time");
  return raw;
}
function string(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Invalid durable log identity");
  return raw;
}
function array<T>(raw: unknown, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(raw)) throw new Error("Invalid durable log array");
  return raw.map(parse);
}
function value<T>(schema: Schema<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error("Durable log payload rejected by schema");
  return parsed.data;
}

/** Select one isolated log in a caller-owned backing store. */
export function logKey(key = "default"): string {
  return `@@es/${encodeURIComponent(key)}/log`;
}

/** Encode an admission identity once, before it reaches a storage adapter. */
export function messageId(
  kind: "caller" | "generated" | "answer",
  ...parts: readonly (string | number)[]
): string {
  return JSON.stringify([kind, ...parts]);
}

function timer<M>(raw: unknown, schema: Schema<M>): LoggedTimer<M> {
  const r = object(raw);
  if (typeof r.fired !== "boolean")
    throw new Error("Invalid durable timer status");
  return {
    id: string(r.id),
    subId: string(r.subId),
    at: number(r.at),
    msg: value(schema, r.msg),
    fired: r.fired,
  };
}

function parseMessage<M>(raw: unknown, schema: Schema<M>): LogMessage<M> {
  const r = object(raw);
  return {
    _tag: "message",
    id: string(r.id),
    at: number(r.at),
    msg: value(schema, r.msg),
  };
}

function parseRecord<S, M, C>(
  raw: unknown,
  options: EventSourcedOptions<S, M, C>,
): LogRecord<S, M, C> {
  const r = object(raw);
  const owed = () =>
    array(r.owed, (raw): EffectOwed<C> => {
      const e = object(raw);
      if (e._tag !== "effect_owed") throw new Error("Invalid owed event");
      return {
        _tag: "effect_owed",
        id: integer(e.id, 1),
        effect: value(options.command, e.effect),
      };
    });
  const timers = () => array(r.timers, (raw) => timer(raw, options.message));
  const parsers = {
    birth: () =>
      ({
        _tag: "birth",
        at: number(r.at),
        state: value(options.state, r.state),
        owed: owed(),
        timers: timers(),
      }) as const,
    message: () => parseMessage(r, options.message),
    step: (): LogRecord<S, M, C> => {
      const disposition = r.disposition;
      if (
        disposition !== "applied" &&
        disposition !== "ignored" &&
        disposition !== "rejected"
      )
        throw new Error("Invalid disposition");
      const failure = r.failure === undefined ? undefined : object(r.failure);
      if (failure && failure.kind !== "reduce" && failure.kind !== "no_cell")
        throw new Error("Invalid log failure");
      return {
        _tag: "step",
        sourceId: string(r.sourceId),
        state: value(options.state, r.state),
        owed: owed(),
        timers: timers(),
        disposition,
        ...(failure
          ? {
              failure: {
                kind: failure.kind as "reduce" | "no_cell",
                message: string(failure.message),
              },
            }
          : {}),
      };
    },
    confirmed: () => {
      const e = object(r.event);
      if (e._tag !== "effect_confirmed")
        throw new Error("Invalid confirmation");
      return {
        _tag: "confirmed",
        event: { _tag: "effect_confirmed", id: integer(e.id, 1) },
      } as const;
    },
  } satisfies Record<LogRecord<S, M, C>["_tag"], () => LogRecord<S, M, C>>;
  const tag = string(r._tag);
  if (!Object.hasOwn(parsers, tag))
    throw new Error("Unknown durable log record");
  return parsers[tag as keyof typeof parsers]();
}

/** Read committed State fields; never invoke historical reducers or init. */
export function committedState<S, M, C>(log: LogRead<S, M, C>): S | null {
  let state: S | null = log.snapshot?.state ?? null;
  for (const { seq, record } of log.records) {
    if (seq <= (log.snapshot?.through ?? 0)) continue;
    if (record._tag === "birth" || record._tag === "step") state = record.state;
  }
  return state;
}

/** Restore the single delivery ledger, including its consumed high-water mark. */
export function logLedger<S, M, C>(log: LogRead<S, M, C>) {
  const events: EffectLedgerEvent<C>[] = [];
  for (const { record } of log.records) {
    if (record._tag === "birth" || record._tag === "step")
      events.push(...record.owed);
    if (record._tag === "confirmed") events.push(record.event);
  }
  return pendingEffectsLedger({ events });
}

/** Unconsumed sources, in durable admission order. */
export function pendingMessages<S, M, C>(
  log: LogRead<S, M, C>,
): readonly LogMessage<M>[] {
  const consumed = new Set(
    log.records.flatMap(({ record }) =>
      record._tag === "step" ? [record.sourceId] : [],
    ),
  );
  return log.records.flatMap(({ record }) =>
    record._tag === "message" && !consumed.has(record.id) ? [record] : [],
  );
}

/** Query applied sources in commit order with inclusive, gap-free query positions. */
export function logUpdates<S, M, C>(
  log: LogRead<S, M, C>,
  range?: { readonly fromSeq?: number; readonly toSeq?: number },
): readonly { readonly seq: number; readonly event: M; readonly state: S }[] {
  const messages = new Map(
    log.records.flatMap(({ record }) =>
      record._tag === "message" ? [[record.id, record.msg] as const] : [],
    ),
  );
  let seq = 0;
  return log.records.flatMap(({ record }) => {
    if (record._tag !== "step" || record.disposition !== "applied") return [];
    seq += 1;
    return seq >= (range?.fromSeq ?? 1) &&
      seq <= (range?.toSeq ?? Number.POSITIVE_INFINITY)
      ? [
          {
            seq,
            event: messages.get(record.sourceId) as M,
            state: record.state,
          },
        ]
      : [];
  });
}

/** One physical record write and the projection change to install after acknowledgement. */
export interface PreparedLogWrite<T> {
  readonly suffix: string;
  readonly bytes: string;
  readonly result: T;
  accept(): void;
}

type Snapshot<S, M, C> = LogRead<S, M, C>["snapshot"];
type Frame<S, M, C> = PersistedLogRecord<LogRecord<S, M, C>> & {
  readonly protocol: 2;
  readonly snapshot: Snapshot<S, M, C>;
};

/** Open a private, incrementally maintained projection of validated protocol records. */
export function logWriter<S, M, C>(options: EventSourcedOptions<S, M, C>) {
  const records: PersistedLogRecord<LogRecord<S, M, C>>[] = [];
  type Source = {
    entry: PersistedLogRecord<LogMessage<M>>;
    step?: Extract<LogRecord<S, M, C>, { _tag: "step" }>;
    appliedCount?: number;
  };
  const sources = new Map<string, Source>();
  const sourceSeqs = new Map<number, Source>();
  const pending: Source[] = [];
  const deliveries = new Map<DeliveryId, boolean>();
  let cursor = 0;
  let state: S | null = null;
  let timers: readonly LoggedTimer<M>[] = [];
  let birth: Extract<LogRecord<S, M, C>, { _tag: "birth" }> | undefined;
  let high = 0;
  let applied = 0;
  let baseline = 0;
  let through = 0;
  let snapshot: Snapshot<S, M, C> = null;

  function acceptSnapshot(raw: unknown): void {
    if (raw === null) return;
    const r = object(raw);
    const boundary = integer(r.through, 1);
    const source = sourceSeqs.get(boundary);
    if (
      !source?.step ||
      source.appliedCount === undefined ||
      boundary > through
    )
      throw new Error("Invalid checkpoint boundary");
    if (boundary < (snapshot?.through ?? 0)) return;
    const parsed = options.state.safeParse(r.state);
    if (!parsed.success) return;
    snapshot = { through: boundary, state: parsed.data };
    baseline = source.appliedCount;
  }

  function accept(
    row: PersistedLogRecord<LogRecord<S, M, C>>,
    checkpoint: unknown = null,
  ): void {
    const { seq, record } = row;
    if (seq !== records.length + 1 || (seq === 1 && record._tag !== "birth"))
      throw new Error("Invalid durable log ordering");
    const consumers = {
      birth: (r: Extract<LogRecord<S, M, C>, { _tag: "birth" }>) => {
        if (birth) throw new Error("Duplicate birth");
        birth = r;
        install(r);
      },
      message: (r: LogMessage<M>) => {
        if (sources.has(r.id)) throw new Error("Duplicate log source");
        const source = { entry: { seq, record: r } };
        sources.set(r.id, source);
        sourceSeqs.set(seq, source);
        pending.push(source);
      },
      step: (r: Extract<LogRecord<S, M, C>, { _tag: "step" }>) => {
        const source = pending[cursor];
        if (source?.entry.record.id !== r.sourceId)
          throw new Error("Invalid source receipt");
        source.step = r;
        if (r.disposition === "applied") applied += 1;
        source.appliedCount = applied;
        through = source.entry.seq;
        cursor += 1;
        install(r);
      },
      confirmed: (r: Extract<LogRecord<S, M, C>, { _tag: "confirmed" }>) => {
        if (deliveries.get(r.event.id) !== false)
          throw new Error("Invalid delivery receipt");
        deliveries.set(r.event.id, true);
      },
    } satisfies {
      [K in LogRecord<S, M, C>["_tag"]]: (
        r: Extract<LogRecord<S, M, C>, { _tag: K }>,
      ) => void;
    };
    // The discriminant selects the matching table row, which is total over the protocol union.
    consumers[record._tag](record as never);
    records.push(row);
    acceptSnapshot(checkpoint);
  }

  function install(
    record: Extract<LogRecord<S, M, C>, { _tag: "birth" | "step" }>,
  ): void {
    for (const owed of record.owed) {
      if (owed.id <= high) throw new Error("Invalid delivery ordering");
      high = owed.id;
      deliveries.set(owed.id, false);
    }
    state = record.state;
    timers = record.timers;
  }

  function restore(bytes: string): void {
    const raw = object(JSON.parse(bytes));
    if (raw.protocol !== 2) throw new Error("Unsupported durable log protocol");
    accept(
      { seq: integer(raw.seq, 1), record: parseRecord(raw.record, options) },
      raw.snapshot,
    );
  }

  function prepare<T>(
    record: LogRecord<S, M, C>,
    checkpoint: Snapshot<S, M, C>,
    result: (row: PersistedLogRecord<LogRecord<S, M, C>>) => T,
  ): PreparedLogWrite<T> {
    const frame: Frame<S, M, C> = {
      protocol: 2,
      seq: records.length + 1,
      record,
      snapshot: checkpoint,
    };
    const bytes = JSON.stringify(frame);
    const raw = object(JSON.parse(bytes));
    const canonical = parseRecord(raw.record, options);
    const row = { seq: frame.seq, record: canonical };
    return {
      suffix: frame.seq === 1 ? "" : `/${frame.seq}`,
      bytes,
      result: structuredClone(result(row)),
      accept: () => accept(row, raw.snapshot),
    };
  }

  return {
    version: () => records.length,
    state: () => structuredClone(state),
    read: (): LogRead<S, M, C> =>
      structuredClone({ version: records.length, records, snapshot, timers }),
    restore,
    restoreCheckpoint(bytes: string) {
      const raw = object(JSON.parse(bytes));
      if (raw.protocol !== 2)
        throw new Error("Unsupported checkpoint protocol");
      acceptSnapshot(raw.snapshot);
    },
    append(
      message: LogMessage<M>,
    ): LogAppend<M> | PreparedLogWrite<LogAppend<M>> {
      if (!birth) throw new Error("A log requires birth before admission");
      const existing = sources.get(message.id);
      if (existing)
        return structuredClone({
          version: records.length,
          appended: false,
          entry: existing.entry,
        });
      return prepare(message, null, (row) => ({
        version: row.seq,
        appended: true,
        entry: row as PersistedLogRecord<LogMessage<M>>,
      }));
    },
    commit(
      step: LogStep<S, M, C>,
    ): LogCommit<S, C> | PreparedLogWrite<LogCommit<S, C>> {
      const existing =
        step._tag === "birth" ? birth : sources.get(step.sourceId)?.step;
      if (existing)
        return structuredClone({
          version: records.length,
          state: existing.state,
          owed: existing.owed.map(({ id, effect }) => ({ id, effect })),
        });
      if (
        step._tag === "birth"
          ? records.length !== 0
          : pending[cursor]?.entry.record.id !== step.sourceId
      )
        throw new Error("Commit requires birth or the first pending source");
      const recorder = pendingEffectsLedger<C>({ lastId: high });
      const owed = step.cmds.map((cmd) => recorder.owe(cmd).event);
      const record: LogRecord<S, M, C> =
        step._tag === "birth"
          ? {
              _tag: "birth",
              at: step.at,
              state: step.state,
              owed,
              timers: step.timers,
            }
          : {
              _tag: "step",
              sourceId: step.sourceId,
              state: step.state,
              owed,
              timers: step.timers,
              disposition: step.disposition,
              ...(step.failure ? { failure: step.failure } : {}),
            };
      const source = pending[cursor];
      const checkpoint =
        source !== undefined &&
        step._tag === "message" &&
        step.disposition === "applied" &&
        applied + 1 - baseline >= (options.snapshotEvery ?? 100)
          ? { through: source.entry.seq, state: step.state }
          : null;
      return prepare(record, checkpoint, (row) => {
        const r = row.record;
        if (r._tag !== "birth" && r._tag !== "step")
          throw new Error("Invalid committed record");
        return {
          version: row.seq,
          state: r.state,
          owed: r.owed.map(({ id, effect }) => ({ id, effect })),
        };
      });
    },
    confirm(
      id: DeliveryId,
    ): LogConfirmation | PreparedLogWrite<LogConfirmation> {
      integer(id, 1);
      if (deliveries.get(id) !== false)
        return { version: records.length, confirmed: false };
      return prepare(
        { _tag: "confirmed", event: { _tag: "effect_confirmed", id } },
        null,
        (row) => ({ version: row.seq, confirmed: true }),
      );
    },
    checkpoint(): boolean | PreparedLogWrite<boolean> {
      if (applied === baseline || state === null) return false;
      const next = { through, state };
      const bytes = JSON.stringify({ protocol: 2, snapshot: next });
      return {
        suffix: "/checkpoint",
        bytes,
        result: true,
        accept: () => acceptSnapshot(next),
      };
    },
  };
}
