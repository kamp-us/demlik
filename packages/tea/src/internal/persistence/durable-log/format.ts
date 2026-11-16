/** The neutral serialized log format and its pure write decisions. */

import type { DeliveryId } from "../../../pure/core";
import { structuralHash } from "../../../pure/core";
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

/** A versioned namespace envelope; derived checkpoints never replace history. */
export interface LogEnvelope<S, M, C> extends LogRead<S, M, C> {
  readonly protocol: 1;
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

/** Parse and validate an envelope without rewriting malformed or legacy bytes. */
export function readEnvelope<S, M, C>(
  bytes: string | undefined,
  options: EventSourcedOptions<S, M, C>,
): LogEnvelope<S, M, C> {
  if (bytes === undefined)
    return { protocol: 1, version: 0, records: [], snapshot: null, timers: [] };
  const raw = object(JSON.parse(bytes));
  if (raw.protocol !== 1) throw new Error("Unsupported durable log protocol");
  const version = integer(raw.version);
  const records = array(raw.records, (raw) => {
    const row = object(raw);
    return {
      seq: integer(row.seq, 1),
      record: parseRecord(row.record, options),
    };
  });
  const messages = new Set<string>();
  const consumed = new Set<string>();
  const deliveries = new Set<number>();
  const confirmed = new Set<number>();
  let high = 0;
  for (const [index, { seq, record }] of records.entries()) {
    if (
      seq !== index + 1 ||
      (index === 0 && record._tag !== "birth") ||
      (index > 0 && record._tag === "birth")
    )
      throw new Error("Invalid durable log ordering");
    if (record._tag === "message") {
      if (messages.has(record.id)) throw new Error("Duplicate log source");
      messages.add(record.id);
    }
    if (record._tag === "step") {
      if (!messages.has(record.sourceId) || consumed.has(record.sourceId))
        throw new Error("Invalid source receipt");
      consumed.add(record.sourceId);
    }
    if (record._tag === "birth" || record._tag === "step") {
      for (const e of record.owed) {
        if (e.id <= high) throw new Error("Invalid delivery ordering");
        high = e.id;
        deliveries.add(e.id);
      }
    }
    if (record._tag === "confirmed") {
      if (!deliveries.has(record.event.id) || confirmed.has(record.event.id))
        throw new Error("Invalid delivery receipt");
      confirmed.add(record.event.id);
    }
  }
  if (version !== records.length)
    throw new Error("Invalid durable log revision");
  let snapshot: LogRead<S, M, C>["snapshot"] = null;
  if (raw.snapshot !== null) {
    const saved = object(raw.snapshot);
    const through = integer(saved.through, 1);
    const source = records.find((r) => r.seq === through)?.record;
    if (
      source?._tag !== "message" ||
      !consumed.has(source.id) ||
      records.some(
        (r) =>
          r.seq <= through &&
          r.record._tag === "message" &&
          !consumed.has(r.record.id),
      )
    )
      throw new Error("Invalid checkpoint boundary");
    const parsed = options.state.safeParse(saved.state);
    if (parsed.success) snapshot = { through, state: parsed.data };
  }
  const last = [...records]
    .reverse()
    .find(({ record }) => record._tag === "birth" || record._tag === "step");
  // Validate the redundant envelope projection as protocol data too.
  array(raw.timers, (r) => timer(r, options.message));
  const timers =
    last && (last.record._tag === "birth" || last.record._tag === "step")
      ? last.record.timers
      : [];
  return { protocol: 1, version, records, snapshot, timers };
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

function append<S, M, C>(
  log: LogEnvelope<S, M, C>,
  record: LogRecord<S, M, C>,
): LogEnvelope<S, M, C> {
  return {
    ...log,
    version: log.version + 1,
    records: [...log.records, { seq: log.records.length + 1, record }],
    timers:
      record._tag === "birth" || record._tag === "step"
        ? record.timers
        : log.timers,
  };
}

/** Choose first-payload-wins admission and its one physical write. */
export function appendLogMessage<S, M, C>(
  log: LogEnvelope<S, M, C>,
  message: LogMessage<M>,
  schema: Schema<M>,
): readonly [LogEnvelope<S, M, C>, LogAppend<M>] {
  if (log.records.length === 0)
    throw new Error("A log requires birth before admission");
  const existing = log.records.find(
    (r): r is PersistedLogRecord<LogMessage<M>> =>
      r.record._tag === "message" && r.record.id === message.id,
  );
  if (existing)
    return [log, { version: log.version, appended: false, entry: existing }];
  const canonical = parseMessage(message, schema);
  const next = append(log, canonical);
  return [
    next,
    {
      version: next.version,
      appended: true,
      entry: { seq: next.records.length, record: canonical },
    },
  ];
}

/** Choose a data-only checkpoint over fully consumed sources. */
export function checkpointLog<S, M, C>(
  log: LogEnvelope<S, M, C>,
): readonly [LogEnvelope<S, M, C>, boolean] {
  const pending = new Set(pendingMessages(log).map((m) => m.id));
  let through = 0;
  for (const row of log.records) {
    if (row.record._tag !== "message") continue;
    if (pending.has(row.record.id)) break;
    through = row.seq;
  }
  const applied = log.records.filter(
    ({ record }) =>
      record._tag === "step" &&
      record.disposition === "applied" &&
      log.records.some(
        (r) =>
          r.seq > (log.snapshot?.through ?? 0) &&
          r.seq <= through &&
          r.record._tag === "message" &&
          r.record.id === record.sourceId,
      ),
  );
  if (applied.length === 0) return [log, false];
  // Commits are ordered by their source sequence, so this is the consumed prefix State.
  const last = [...log.records]
    .reverse()
    .find(
      ({ record }) =>
        record._tag === "step" &&
        log.records.some(
          (r) =>
            r.seq <= through &&
            r.record._tag === "message" &&
            r.record.id === record.sourceId,
        ),
    );
  if (last?.record._tag !== "step") return [log, false];
  return [{ ...log, snapshot: { through, state: last.record.state } }, true];
}

/** Choose one atomic State/owed/source-receipt record, with automatic checkpoint metadata. */
export function commitLogStep<S, M, C>(
  log: LogEnvelope<S, M, C>,
  step: LogStep<S, M, C>,
  every: number,
): readonly [LogEnvelope<S, M, C>, LogCommit<C>] {
  const existing = log.records.find(({ record }) =>
    step._tag === "birth"
      ? record._tag === "birth"
      : record._tag === "step" && record.sourceId === step.sourceId,
  );
  if (
    existing &&
    (existing.record._tag === "birth" || existing.record._tag === "step")
  )
    return [
      log,
      {
        version: log.version,
        owed: existing.record.owed.map(({ id, effect }) => ({ id, effect })),
      },
    ];
  if (step._tag === "birth" && log.records.length !== 0)
    throw new Error("Birth requires an empty log");
  if (step._tag === "message" && pendingMessages(log)[0]?.id !== step.sourceId)
    throw new Error("Commit requires the first pending source");
  const ledger = logLedger(log);
  const owed = step.cmds.map((cmd) => ledger.owe(cmd).event);
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
  let next = append(log, record);
  const sources = new Set(
    log.records
      .filter((r) => r.seq > (log.snapshot?.through ?? 0))
      .flatMap(({ record }) => (record._tag === "message" ? [record.id] : [])),
  );
  const count = next.records.filter(
    ({ record }) =>
      record._tag === "step" &&
      record.disposition === "applied" &&
      sources.has(record.sourceId),
  ).length;
  if (count >= every) next = checkpointLog(next)[0];
  return [
    next,
    {
      version: next.version,
      owed: owed.map(({ id, effect }) => ({ id, effect })),
    },
  ];
}

/** Choose an idempotent confirmation, retaining its receipt after checkpoints. */
export function confirmLogEffect<S, M, C>(
  log: LogEnvelope<S, M, C>,
  id: DeliveryId,
): readonly [LogEnvelope<S, M, C>, LogConfirmation] {
  integer(id, 1);
  const result = logLedger(log).confirm(id);
  if (!result.confirmed)
    return [log, { version: log.version, confirmed: false }];
  const next = append(log, { _tag: "confirmed", event: result.event });
  return [next, { version: next.version, confirmed: true }];
}

/** Compare serialized State without depending on object identity. */
export function sameLogValue(left: unknown, right: unknown): boolean {
  return structuralHash(left) === structuralHash(right);
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
