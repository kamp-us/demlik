/** The neutral log identities and engine queries. */
import type { LogMessage, LogRead, LogRecord } from "../../../runtime-types";
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

