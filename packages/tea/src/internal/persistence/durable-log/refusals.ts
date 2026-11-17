/** Stable diagnostics shared by the codec and pure durable-log rules. */
const messages = {
  invalid_object: "Invalid durable log object",
  invalid_integer: "Invalid durable log integer",
  invalid_time: "Invalid durable log time",
  invalid_identity: "Invalid durable log identity",
  invalid_array: "Invalid durable log array",
  payload_rejected: "Durable log payload rejected by schema",
  invalid_timer_status: "Invalid durable timer status",
  invalid_owed_event: "Invalid owed event",
  invalid_disposition: "Invalid disposition",
  receipt_carries_work: "A source receipt cannot carry State or work",
  invalid_failure: "Invalid log failure",
  invalid_confirmation: "Invalid confirmation",
  unknown_record: "Unknown durable log record",
  invalid_checkpoint_boundary: "Invalid checkpoint boundary",
  invalid_source_receipt: "Invalid source receipt",
  invalid_ordering: "Invalid durable log ordering",
  duplicate_birth_record: "Duplicate birth",
  duplicate_source: "Duplicate log source",
  invalid_delivery_receipt: "Invalid delivery receipt",
  invalid_delivery_ordering: "Invalid delivery ordering",
  unsupported_log_protocol: "Unsupported durable log protocol",
  invalid_committed_record: "Invalid committed record",
  not_first_pending_source: "Commit requires the first pending source",
  unsupported_checkpoint_protocol: "Unsupported checkpoint protocol",
  admission_before_birth: "A log requires birth before admission",
  birth_on_nonempty_log: "Duplicate birth",
} as const;

export type LogRefusal = {
  [K in keyof typeof messages]: { readonly _tag: K };
}[keyof typeof messages];

export type Result<T> = { readonly _tag: "ok"; readonly value: T } | LogRefusal;

export function ok<T>(value: T): Result<T> {
  return { _tag: "ok", value };
}

export function isRefusal(value: unknown): value is LogRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string" &&
    Object.hasOwn(messages, value._tag)
  );
}

export function refusalMessage(refusal: LogRefusal): string {
  const table = messages satisfies Record<LogRefusal["_tag"], string>;
  return table[refusal._tag];
}
