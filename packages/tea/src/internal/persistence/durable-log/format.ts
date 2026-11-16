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

type Cases<R extends { _tag: string }, T> = {
  [K in R["_tag"]]: (record: Extract<R, { _tag: K }>) => T;
};

function visit<R extends { _tag: string }, T>(
  record: R,
  cases: Cases<R, T>,
): T {
  return cases[record._tag as R["_tag"]](record as never);
}

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
  const parsed = schema.safeParse(structuredClone(raw));
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
    applied: () =>
      ({
        _tag: "applied",
        sourceId: string(r.sourceId),
        state: value(options.state, r.state),
        owed: owed(),
        timers: timers(),
      }) as const,
    receipt: (): LogRecord<S, M, C> => {
      const disposition = r.disposition;
      if (disposition !== "ignored" && disposition !== "rejected")
        throw new Error("Invalid disposition");
      if (
        ["state", "owed", "timers", "cmds"].some((key) => Object.hasOwn(r, key))
      )
        throw new Error("A source receipt cannot carry State or work");
      const failure = r.failure === undefined ? undefined : object(r.failure);
      if (failure && failure.kind !== "reduce" && failure.kind !== "no_cell")
        throw new Error("Invalid log failure");
      return {
        _tag: "receipt",
        sourceId: string(r.sourceId),
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
  const install = (record: { state: S }) => {
    state = record.state;
  };
  const readers: Cases<LogRecord<S, M, C>, void> = {
    birth: install,
    applied: install,
    message: () => {},
    receipt: () => {},
    confirmed: () => {},
  };
  for (const { seq, record } of log.records)
    if (seq > (log.snapshot?.through ?? 0)) visit(record, readers);
  return state;
}

/** Restore the single delivery ledger, including its consumed high-water mark. */
export function logLedger<S, M, C>(log: LogRead<S, M, C>) {
  const events: EffectLedgerEvent<C>[] = [];
  const owed = (record: { owed: readonly EffectOwed<C>[] }) => {
    events.push(...record.owed);
  };
  const readers: Cases<LogRecord<S, M, C>, void> = {
    birth: owed,
    applied: owed,
    message: () => {},
    receipt: () => {},
    confirmed: (record) => {
      events.push(record.event);
    },
  };
  for (const { record } of log.records) visit(record, readers);
  return pendingEffectsLedger({ events });
}

/** Source IDs consumed by either an applied transition or a receipt. */
export function consumedSources<S, M, C>(
  log: LogRead<S, M, C>,
): ReadonlySet<string> {
  const consumed = new Set<string>();
  const consume = (record: { sourceId: string }) => {
    consumed.add(record.sourceId);
  };
  const readers: Cases<LogRecord<S, M, C>, void> = {
    birth: () => {},
    applied: consume,
    receipt: consume,
    message: () => {},
    confirmed: () => {},
  };
  for (const { record } of log.records) visit(record, readers);
  return consumed;
}

/** Unconsumed sources, in durable admission order. */
export function pendingMessages<S, M, C>(
  log: LogRead<S, M, C>,
): readonly LogMessage<M>[] {
  const consumed = consumedSources(log);
  const readers: Cases<LogRecord<S, M, C>, readonly LogMessage<M>[]> = {
    birth: () => [],
    applied: () => [],
    receipt: () => [],
    confirmed: () => [],
    message: (record) => (consumed.has(record.id) ? [] : [record]),
  };
  return log.records.flatMap(({ record }) => visit(record, readers));
}

/** Query applied sources in commit order with inclusive, gap-free query positions. */
export function logUpdates<S, M, C>(
  log: LogRead<S, M, C>,
  range?: { readonly fromSeq?: number; readonly toSeq?: number },
): readonly { readonly seq: number; readonly event: M; readonly state: S }[] {
  const messages = new Map<string, M>();
  const rows: { seq: number; event: M; state: S }[] = [];
  let seq = 0;
  const readers: Cases<LogRecord<S, M, C>, void> = {
    birth: () => {},
    receipt: () => {},
    confirmed: () => {},
    message: (record) => {
      messages.set(record.id, record.msg);
    },
    applied: (record) => {
      seq += 1;
      if (
        seq >= (range?.fromSeq ?? 1) &&
        seq <= (range?.toSeq ?? Number.POSITIVE_INFINITY)
      )
        rows.push({
          seq,
          event: messages.get(record.sourceId) as M,
          state: record.state,
        });
    },
  };
  for (const { record } of log.records) visit(record, readers);
  return rows;
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
  type Applied = Extract<LogRecord<S, M, C>, { _tag: "applied" }>;
  type Receipt = Extract<LogRecord<S, M, C>, { _tag: "receipt" }>;
  const records: PersistedLogRecord<LogRecord<S, M, C>>[] = [];
  type Source = {
    entry: PersistedLogRecord<LogMessage<M>>;
    commit?: Applied | Receipt;
    appliedCount?: number;
  };
  const sources = new Map<string, Source>();
  const sourceSeqs = new Map<number, Source>();
  const pending: Source[] = [];
  const deliveries = new Map<DeliveryId, boolean>();
  let cursor = 0;
  let state: S | null = null;
  let storedState: unknown;
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
      !source?.commit ||
      source.appliedCount === undefined ||
      boundary > through
    )
      throw new Error("Invalid checkpoint boundary");
    if (boundary < (snapshot?.through ?? 0)) return;
    const parsed = options.state.safeParse(structuredClone(r.state));
    if (!parsed.success) return;
    snapshot = { through: boundary, state: parsed.data };
    baseline = source.appliedCount;
  }

  function consume(record: Applied | Receipt): void {
    const source = pending[cursor];
    if (source?.entry.record.id !== record.sourceId)
      throw new Error("Invalid source receipt");
    source.commit = record;
    source.appliedCount = applied;
    through = source.entry.seq;
    cursor += 1;
  }

  function accept(
    row: PersistedLogRecord<LogRecord<S, M, C>>,
    stored: Record<string, unknown>,
    checkpoint: unknown = null,
  ): void {
    const { seq, record } = row;
    if (seq !== records.length + 1 || (seq === 1 && record._tag !== "birth"))
      throw new Error("Invalid durable log ordering");
    const consumers: Cases<LogRecord<S, M, C>, void> = {
      birth: (r) => {
        if (birth) throw new Error("Duplicate birth");
        birth = r;
        install(r, stored.state);
      },
      message: (r) => {
        if (sources.has(r.id)) throw new Error("Duplicate log source");
        const source = { entry: { seq, record: r } };
        sources.set(r.id, source);
        sourceSeqs.set(seq, source);
        pending.push(source);
      },
      applied: (r) => {
        applied += 1;
        consume(r);
        install(r, stored.state);
      },
      receipt: consume,
      confirmed: (r) => {
        if (deliveries.get(r.event.id) !== false)
          throw new Error("Invalid delivery receipt");
        deliveries.set(r.event.id, true);
      },
    };
    visit(record, consumers);
    records.push(row);
    acceptSnapshot(checkpoint);
  }

  function install(
    record: Extract<LogRecord<S, M, C>, { _tag: "birth" | "applied" }>,
    stored: unknown,
  ): void {
    for (const owed of record.owed) {
      if (owed.id <= high) throw new Error("Invalid delivery ordering");
      high = owed.id;
      deliveries.set(owed.id, false);
    }
    state = record.state;
    storedState = stored;
    timers = record.timers;
  }

  function restore(bytes: string): void {
    const raw = object(JSON.parse(bytes));
    if (raw.protocol !== 2) throw new Error("Unsupported durable log protocol");
    accept(
      { seq: integer(raw.seq, 1), record: parseRecord(raw.record, options) },
      object(raw.record),
      raw.snapshot,
    );
  }

  function prepare<T>(
    record: LogRecord<S, M, C>,
    checkpointThrough: number | null,
    result: (row: PersistedLogRecord<LogRecord<S, M, C>>) => T,
  ): PreparedLogWrite<T> {
    const frame: Frame<S, M, C> = {
      protocol: 2,
      seq: records.length + 1,
      record,
      snapshot: null,
    };
    let bytes = JSON.stringify(frame);
    const raw = object(JSON.parse(bytes));
    const stored = object(raw.record);
    // Copy the encoded State, so a checkpoint never evaluates its producer again.
    if (checkpointThrough !== null) {
      raw.snapshot = { through: checkpointThrough, state: stored.state };
      bytes = JSON.stringify(raw);
    }
    const row = { seq: frame.seq, record: parseRecord(stored, options) };
    return {
      suffix: frame.seq === 1 ? "" : `/${frame.seq}`,
      bytes,
      result: structuredClone(result(row)),
      accept: () => accept(row, stored, raw.snapshot),
    };
  }

  function committed(
    record: LogRecord<S, M, C>,
    version: number,
  ): LogCommit<S, C> {
    const withState = (r: { state: S; owed: readonly EffectOwed<C>[] }) => ({
      version,
      state: r.state,
      owed: r.owed.map(({ id, effect }) => ({ id, effect })),
    });
    const invalid = (): never => {
      throw new Error("Invalid committed record");
    };
    const readers: Cases<LogRecord<S, M, C>, LogCommit<S, C>> = {
      birth: withState,
      applied: withState,
      receipt: () => ({ version, state: state as S, owed: [] }),
      message: invalid,
      confirmed: invalid,
    };
    return visit(record, readers);
  }

  function requireSource(sourceId: string): Source {
    const source = pending[cursor];
    if (source?.entry.record.id !== sourceId)
      throw new Error("Commit requires the first pending source");
    return source;
  }
  function owe(cmds: readonly C[]) {
    const recorder = pendingEffectsLedger<C>({ lastId: high });
    return cmds.map((cmd) => recorder.owe(cmd).event);
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
      const previous = (r: { sourceId: string }) =>
        sources.get(r.sourceId)?.commit;
      const existing = visit<LogStep<S, M, C>, LogRecord<S, M, C> | undefined>(
        step,
        {
          birth: () => birth,
          applied: previous,
          receipt: previous,
        } satisfies Cases<LogStep<S, M, C>, LogRecord<S, M, C> | undefined>,
      );
      if (existing) return structuredClone(committed(existing, records.length));
      type Proposal = { record: LogRecord<S, M, C>; checkpoint: number | null };
      const writers: Cases<LogStep<S, M, C>, Proposal> = {
        birth: (r) => {
          if (records.length !== 0) throw new Error("Duplicate birth");
          return {
            record: {
              _tag: "birth",
              at: r.at,
              state: r.state,
              owed: owe(r.cmds),
              timers: r.timers,
            },
            checkpoint: null,
          };
        },
        applied: (r) => {
          const source = requireSource(r.sourceId);
          return {
            record: {
              _tag: "applied",
              sourceId: r.sourceId,
              state: r.state,
              owed: owe(r.cmds),
              timers: r.timers,
            },
            checkpoint:
              applied + 1 - baseline >= (options.snapshotEvery ?? 100)
                ? source.entry.seq
                : null,
          };
        },
        receipt: (r) => {
          requireSource(r.sourceId);
          return {
            record: {
              _tag: "receipt",
              sourceId: r.sourceId,
              disposition: r.disposition,
              ...(r.failure ? { failure: r.failure } : {}),
            },
            checkpoint: null,
          };
        },
      };
      const proposal = visit(step, writers);
      return prepare(proposal.record, proposal.checkpoint, (row) =>
        committed(row.record, row.seq),
      );
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
      if (applied === baseline || !birth) return false;
      const next = { through, state: storedState };
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
