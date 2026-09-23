/**
 * The three Standard Schemas tea's own `Cmd.define`s need, written by hand so
 * the published package depends on no schema library (ADR 0021 §5).
 *
 * A battery's Cmd input is data it built itself and its `ok` is mostly a type
 * annotation, so what these check is deliberately thin: `unchecked<T>()` names
 * a type and checks nothing, `undefinedOnly` is a handler that settles with no
 * value, and `rejectAll` is a Cmd that never settles `Ok`. A consumer's own
 * `Cmd.define` brings a real schema — zod, Effect Schema — instead.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

const VENDOR = "@demlik/tea";

function schema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T, T> {
  return { "~standard": { version: 1, vendor: VENDOR, validate } };
}

/** Accept every value as `T`. The type is the whole contract. */
export function unchecked<T>(): StandardSchemaV1<T, T> {
  return schema((value) => ({ value: value as T }));
}

/** Accept `undefined` only — the `ok` of a handler that settles with no value. */
export const undefinedOnly: StandardSchemaV1<undefined, undefined> = schema(
  (value) =>
    value === undefined
      ? { value: undefined }
      : { issues: [{ message: "expected no value" }] },
);

/** Accept nothing — the `ok` of a Cmd whose handler only ever fails. */
export const rejectAll: StandardSchemaV1<never, never> = schema(() => ({
  issues: [{ message: "this Cmd never settles Ok" }],
}));
