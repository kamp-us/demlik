import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as FastCheck from "../../packages/tea/node_modules/fast-check";
import {
  arbConstantMsg,
  arbRecordMsg,
} from "../../packages/tea/src/pbt/index.js";
import type {
  FixedScript,
  NumberInput,
  TextInput,
  ValueSpec,
} from "./pbt-constructors-cases.mts";

const require = createRequire(
  new URL("../../packages/tea/package.json", import.meta.url),
);
const fc: typeof FastCheck = require("fast-check");
export const fastCheckVersion = fc.__version;
export function numberOf(n: NumberInput): number {
  if (typeof n === "number") return n;
  return n.$number === "NaN"
    ? NaN
    : n.$number === "Infinity"
      ? Infinity
      : n.$number === "-Infinity"
        ? -Infinity
        : -0;
}
export function numberView(n: number): unknown {
  return Number.isNaN(n)
    ? { $number: "NaN" }
    : n === Infinity
      ? { $number: "Infinity" }
      : n === -Infinity
        ? { $number: "-Infinity" }
        : Object.is(n, -0)
          ? { $number: "-0" }
          : n;
}
function textOf(t: TextInput): string {
  return typeof t === "string" ? t : String.fromCharCode(...t.$utf16);
}
function units(t: string) {
  return Array.from({ length: t.length }, (_, i) => t.charCodeAt(i));
}
function prepare(specs: ValueSpec[]): unknown[] {
  return specs.map((s) => {
    switch (s.type) {
      case "undefined":
        return undefined;
      case "null":
        return null;
      case "bool":
        return s.value;
      case "number":
        return numberOf(s.value);
      case "text":
        return textOf(s.value);
      case "object":
        return { n: numberOf(s.n) };
      case "array":
        return [numberOf(s.n)];
      case "function": {
        let n = numberOf(s.n);
        const fn = () => n;
        Object.defineProperty(fn, "n", {
          get: () => n,
          set: (v) => {
            n = v;
          },
          enumerable: true,
        });
        return fn;
      }
    }
    return assert.fail("unexpected fixture payload");
  });
}
function view(value: unknown): unknown {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "bool", value };
  if (typeof value === "number")
    return { type: "number", value: numberView(value) };
  if (typeof value === "string") return { type: "text", units: units(value) };
  if (Array.isArray(value)) {
    assert.equal(typeof value[0], "number");
    return { type: "array", n: numberView(value[0]) };
  }
  assert(
    (typeof value === "object" && value !== null) ||
      typeof value === "function",
  );
  const n: unknown = Reflect.get(value, "n");
  assert.equal(typeof n, "number");
  if (typeof value === "function") {
    const called: unknown = Reflect.apply(value, undefined, []);
    assert.equal(typeof called, "number");
    return {
      type: "function",
      n: numberView(Number(n)),
      call: numberView(Number(called)),
    };
  }
  return { type: "object", n: numberView(Number(n)) };
}
function messageView(
  message: Record<string, unknown>,
  expected: { value?: unknown; extra?: unknown },
): unknown {
  const tag = message.type;
  assert.equal(typeof tag, "string");
  const names: ("value" | "extra")[] = ["value", "extra"];
  const fields = Object.fromEntries(
    names.map((key) => {
      const present = Object.hasOwn(message, key);
      return [
        key,
        present
          ? {
              present,
              value: view(message[key]),
              sameOriginal:
                Object.hasOwn(expected, key) &&
                Object.is(message[key], expected[key]),
            }
          : { present, sameOriginal: !Object.hasOwn(expected, key) },
      ];
    }),
  );
  return { tagUnits: units(String(tag)), keys: Object.keys(message), fields };
}
export function executePbtConstructor(input: FixedScript) {
  assert.equal(fastCheckVersion, "3.23.2");
  if (input.kind === "constant") {
    const messages = fc.sample(arbConstantMsg(input.tag), {
      seed: 731,
      numRuns: input.draws,
    });
    const before = messages.map((m) => messageView(m, {}));
    return {
      comparison: {
        status: "ok",
        before,
        after: before,
        sameAsFirst: messages.map((m) => m === messages[0]),
      },
      diagnostics: {},
    };
  }
  const values = prepare(input.values),
    fields: Record<string, FastCheck.Arbitrary<unknown>> = {},
    expected: { value?: unknown; extra?: unknown } = {};
  if (input.value !== undefined) {
    fields.value = fc.constant(values[input.value]);
    expected.value = values[input.value];
  }
  if (input.extra !== undefined) {
    fields.extra = fc.constant(values[input.extra]);
    expected.extra = values[input.extra];
  }
  const messages = fc.sample(arbRecordMsg(input.tag, fields), {
    seed: 731,
    numRuns: input.draws,
  });
  const before = messages.map((m) => messageView(m, expected));
  for (const post of input.post ?? []) {
    const v = values[post.slot];
    assert((typeof v === "object" && v !== null) || typeof v === "function");
    if (Array.isArray(v)) v[0] = numberOf(post.n);
    else Reflect.set(v, "n", numberOf(post.n));
  }
  return {
    comparison: {
      status: "ok",
      before,
      after: messages.map((m) => messageView(m, expected)),
      sameAsFirst: messages.map((m) => m === messages[0]),
    },
    diagnostics: {},
  };
}
