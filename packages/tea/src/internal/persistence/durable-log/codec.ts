/** Protocol bytes and schema decoding stay at the storage boundary. */
import type {
  EventSourcedOptions,
  LoggedTimer,
  LogMessage,
  LogRecord,
  PersistedLogRecord,
  Schema,
} from "../../../runtime-types";
import type { EffectOwed } from "./durable-effects";
import type { CheckpointState } from "./projection";
import { ok, type Result } from "./refusals";

function object(raw: unknown): Result<Readonly<Record<string, unknown>>> {
  return typeof raw !== "object" || raw === null || Array.isArray(raw)
    ? { _tag: "invalid_object" }
    : ok(raw as Readonly<Record<string, unknown>>);
}

export function integer(
  raw: unknown,
  min = 0,
):
  | { readonly _tag: "ok"; readonly value: number }
  | { readonly _tag: "invalid_integer" } {
  return typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min
    ? { _tag: "invalid_integer" }
    : { _tag: "ok", value: raw };
}

function time(raw: unknown): Result<number> {
  return typeof raw !== "number" || !Number.isFinite(raw)
    ? { _tag: "invalid_time" }
    : ok(raw);
}

function identity(raw: unknown): Result<string> {
  return typeof raw !== "string" ? { _tag: "invalid_identity" } : ok(raw);
}

function array<T>(
  raw: unknown,
  parse: (value: unknown) => Result<T>,
): Result<readonly T[]> {
  if (!Array.isArray(raw)) return { _tag: "invalid_array" };
  const values: T[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (parsed._tag !== "ok") return parsed;
    values.push(parsed.value);
  }
  return ok(values);
}

function value<T>(schema: Schema<T>, raw: unknown): Result<T> {
  const parsed = schema.safeParse(structuredClone(raw));
  return parsed.success ? ok(parsed.data) : { _tag: "payload_rejected" };
}

function timer<M>(raw: unknown, schema: Schema<M>): Result<LoggedTimer<M>> {
  const parsed = object(raw);
  if (parsed._tag !== "ok") return parsed;
  const r = parsed.value;
  if (typeof r.fired !== "boolean") return { _tag: "invalid_timer_status" };
  const id = identity(r.id);
  if (id._tag !== "ok") return id;
  const subId = identity(r.subId);
  if (subId._tag !== "ok") return subId;
  const at = time(r.at);
  if (at._tag !== "ok") return at;
  const msg = value(schema, r.msg);
  if (msg._tag !== "ok") return msg;
  return ok({
    id: id.value,
    subId: subId.value,
    at: at.value,
    msg: msg.value,
    fired: r.fired,
  });
}

type Protocol = 2 | 3;
const protocols = {
  2: () => ok(undefined),
  3: (record) =>
    record._tag === "message"
      ? integer(record.answerTo, 1)
      : { _tag: "unsupported_log_protocol" },
} satisfies Record<
  Protocol,
  (record: Readonly<Record<string, unknown>>) => Result<number | undefined>
>;

function message<M>(
  r: Readonly<Record<string, unknown>>,
  schema: Schema<M>,
  answerTo: number | undefined,
): Result<LogMessage<M>> {
  const id = identity(r.id);
  if (id._tag !== "ok") return id;
  const at = time(r.at);
  if (at._tag !== "ok") return at;
  const msg = value(schema, r.msg);
  if (msg._tag !== "ok") return msg;
  return ok({
    _tag: "message",
    id: id.value,
    at: at.value,
    msg: msg.value,
    ...(answerTo === undefined ? {} : { answerTo }),
  });
}

function record<S, M, C>(
  raw: unknown,
  options: EventSourcedOptions<S, M, C>,
  protocol: Protocol,
): Result<LogRecord<S, M, C>> {
  const parsed = object(raw);
  if (parsed._tag !== "ok") return parsed;
  const r = parsed.value;
  const answerTo = protocols[protocol](r);
  if (answerTo._tag !== "ok") return answerTo;
  const work = () => {
    const state = value(options.state, r.state);
    if (state._tag !== "ok") return state;
    const owed = array(r.owed, (raw): Result<EffectOwed<C>> => {
      const parsed = object(raw);
      if (parsed._tag !== "ok") return parsed;
      const e = parsed.value;
      if (e._tag !== "effect_owed") return { _tag: "invalid_owed_event" };
      const id = integer(e.id, 1);
      if (id._tag !== "ok") return id;
      const effect = value(options.command, e.effect);
      if (effect._tag !== "ok") return effect;
      return ok({ _tag: "effect_owed", id: id.value, effect: effect.value });
    });
    if (owed._tag !== "ok") return owed;
    const timers = array(r.timers, (raw) => timer(raw, options.message));
    if (timers._tag !== "ok") return timers;
    return ok({ state: state.value, owed: owed.value, timers: timers.value });
  };
  const parsers = {
    birth: (): Result<LogRecord<S, M, C>> => {
      const at = time(r.at);
      if (at._tag !== "ok") return at;
      const decoded = work();
      if (decoded._tag !== "ok") return decoded;
      return ok({ _tag: "birth", at: at.value, ...decoded.value });
    },
    message: () => message(r, options.message, answerTo.value),
    applied: (): Result<LogRecord<S, M, C>> => {
      const sourceId = identity(r.sourceId);
      if (sourceId._tag !== "ok") return sourceId;
      const decoded = work();
      if (decoded._tag !== "ok") return decoded;
      return ok({
        _tag: "applied",
        sourceId: sourceId.value,
        ...decoded.value,
      });
    },
    receipt: (): Result<LogRecord<S, M, C>> => {
      const disposition = r.disposition;
      if (disposition !== "ignored" && disposition !== "rejected")
        return { _tag: "invalid_disposition" };
      if (
        ["state", "owed", "timers", "cmds"].some((key) => Object.hasOwn(r, key))
      )
        return { _tag: "receipt_carries_work" };
      const failure =
        r.failure === undefined ? ok(undefined) : object(r.failure);
      if (failure._tag !== "ok") return failure;
      const kind = failure.value?.kind;
      if (failure.value && kind !== "reduce" && kind !== "no_cell")
        return { _tag: "invalid_failure" };
      const sourceId = identity(r.sourceId);
      if (sourceId._tag !== "ok") return sourceId;
      if (!failure.value)
        return ok({ _tag: "receipt", sourceId: sourceId.value, disposition });
      const description = identity(failure.value.message);
      if (description._tag !== "ok") return description;
      return ok({
        _tag: "receipt",
        sourceId: sourceId.value,
        disposition,
        failure: {
          kind: kind as "reduce" | "no_cell",
          message: description.value,
        },
      });
    },
    confirmed: (): Result<LogRecord<S, M, C>> => {
      const event = object(r.event);
      if (event._tag !== "ok") return event;
      if (event.value._tag !== "effect_confirmed")
        return { _tag: "invalid_confirmation" };
      const id = integer(event.value.id, 1);
      if (id._tag !== "ok") return id;
      return ok({
        _tag: "confirmed",
        event: { _tag: "effect_confirmed", id: id.value },
      });
    },
  } satisfies Record<
    LogRecord<S, M, C>["_tag"],
    () => Result<LogRecord<S, M, C>>
  >;
  const tag = identity(r._tag);
  if (tag._tag !== "ok") return tag;
  if (!Object.hasOwn(parsers, tag.value)) return { _tag: "unknown_record" };
  return parsers[tag.value as keyof typeof parsers]();
}

export type DecodedFrame<S, M, C> = {
  readonly row: PersistedLogRecord<LogRecord<S, M, C>>;
  readonly storedState: unknown;
  readonly snapshot: Result<CheckpointMetadata | null>;
};

export type CheckpointMetadata = {
  readonly through: number;
  readonly rawState: unknown;
};

export function decodeFrame<S, M, C>(
  bytes: string,
  options: EventSourcedOptions<S, M, C>,
): Result<DecodedFrame<S, M, C>> {
  const raw = object(JSON.parse(bytes));
  if (raw._tag !== "ok") return raw;
  if (
    typeof raw.value.protocol !== "number" ||
    !Object.hasOwn(protocols, raw.value.protocol)
  )
    return { _tag: "unsupported_log_protocol" };
  const seq = integer(raw.value.seq, 1);
  if (seq._tag !== "ok") return seq;
  const decoded = record(
    raw.value.record,
    options,
    raw.value.protocol as Protocol,
  );
  if (decoded._tag !== "ok") return decoded;
  const stored = object(raw.value.record);
  if (stored._tag !== "ok") return stored;
  const snapshot = checkpointMetadata(raw.value.snapshot ?? null);
  return ok({
    row: { seq: seq.value, record: decoded.value },
    storedState: stored.value.state,
    snapshot,
  });
}

export function encodeFrame<S, M, C>(
  entry: LogRecord<S, M, C>,
  seq: number,
  checkpointThrough: number | null,
  options: EventSourcedOptions<S, M, C>,
): Result<DecodedFrame<S, M, C> & { readonly bytes: string }> {
  const protocol =
    entry._tag === "message" && entry.answerTo !== undefined ? 3 : 2;
  let bytes = JSON.stringify({
    protocol,
    seq,
    record: entry,
    snapshot: null,
  });
  const raw = JSON.parse(bytes) as {
    readonly record: unknown;
    snapshot: unknown;
  };
  const stored = object(raw.record);
  if (stored._tag !== "ok") return stored;
  if (checkpointThrough !== null) {
    raw.snapshot = { through: checkpointThrough, state: stored.value.state };
    bytes = JSON.stringify(raw);
  }
  const decoded = record(stored.value, options, protocol);
  if (decoded._tag !== "ok") return decoded;
  const snapshot = checkpointMetadata(raw.snapshot);
  return ok({
    bytes,
    row: { seq, record: decoded.value },
    storedState: stored.value.state,
    snapshot,
  });
}

export function decodeCheckpoint(
  bytes: string,
): Result<CheckpointMetadata | null> {
  const raw = object(JSON.parse(bytes));
  if (raw._tag !== "ok") return raw;
  return raw.value.protocol === 2
    ? checkpointMetadata(raw.value.snapshot)
    : { _tag: "unsupported_checkpoint_protocol" };
}

export function checkpointMetadata(
  raw: unknown,
): Result<CheckpointMetadata | null> {
  if (raw === null) return ok(null);
  const r = object(raw);
  if (r._tag !== "ok") return r;
  const through = integer(r.value.through, 1);
  if (through._tag !== "ok") return through;
  return ok({ through: through.value, rawState: r.value.state });
}

export function checkpointState<S>(
  raw: unknown,
  schema: Schema<S>,
): CheckpointState<S> {
  const parsed = schema.safeParse(structuredClone(raw));
  return parsed.success
    ? { _tag: "decoded", state: parsed.data }
    : { _tag: "state_rejected" };
}

export function encodeCheckpoint(
  through: number,
  storedState: unknown,
): string {
  return JSON.stringify({
    protocol: 2,
    snapshot: { through, state: storedState },
  });
}
