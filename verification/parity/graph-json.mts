import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-json.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const CaseSchema = z.strictObject({
  id: z.string(),
  operation: z.literal("code_graph.json"),
  input: z.strictObject({
    text: z.string(),
    keys: z.array(z.string()).default([]),
  }),
});
type Case = z.infer<typeof CaseSchema>;
const ResultSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const cases: Case[] = [];
const prototypeKeys = Object.getOwnPropertyNames(Object.prototype);
assert.equal(prototypeKeys.length, 12);
function add(id: string, text: string, keys: string[] = []): void {
  cases.push({ id, operation: "code_graph.json", input: { text, keys } });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reference(item: Case): { ok: boolean; output?: unknown } {
  try {
    const value: unknown = JSON.parse(item.input.text);
    const number = typeof value === "number" ? value : null;
    return {
      ok: true,
      output: {
        value: JSON.parse(JSON.stringify(value)),
        stringified: JSON.stringify(value),
        keys: isRecord(value) ? Object.keys(value) : null,
        lookups: item.input.keys.map((key) => ({
          key,
          present: isRecord(value) && Object.hasOwn(value, key),
          null:
            isRecord(value) && Object.hasOwn(value, key) && value[key] === null,
          prototypeProperty: Object.hasOwn(Object.prototype, key),
        })),
        rootNumberKind:
          number === null
            ? null
            : number === Number.POSITIVE_INFINITY
              ? "positive-infinity"
              : number === Number.NEGATIVE_INFINITY
                ? "negative-infinity"
                : Object.is(number, -0)
                  ? "negative-zero"
                  : "finite",
      },
    };
  } catch {
    return { ok: false };
  }
}
add(
  "numeric-own-key-order-duplicates-raw-prototype-and-surrogates",
  String.raw`{"tail":0,"10":"ten","2":"two","01":1,"4294967295":5,"0":0,"4294967294":4,"__proto__":{"polluted":true},"constructor":1,"\ud800":"\udfff","tail":7,"infinite":1e400,"negative":-0}`,
  [...prototypeKeys, "tail", "missing", "\ud800", "\udfff", "toString\u0000"],
);
add(
  "explicit-null-is-distinct-from-missing-and-inherited",
  '{"present":null,"toString":null}',
  ["present", "missing", ...prototypeKeys],
);
add(
  "nested-values-and-unicode",
  String.raw`[null,true,false,{"\u0000":"\b\t\n\f\r\"\\/","Ω":"😀","\ud800":"\udfff"},[],{}]`,
  prototypeKeys,
);
add("deep-valid-json", `${"[".repeat(160)}"\\ud800"${"]".repeat(160)}`);
add(
  "all-integer-enumeration-boundaries",
  '{"00":0,"-0":0,"1.0":0,"1e0":0,"4294967296":0,"4294967295":0,"4294967294":0,"100":0,"2":0,"0":0,"01":0,"":0,"1":0,"١":0}',
);
for (const [index, text] of [
  "1e400",
  "-1e400",
  "-0",
  "1e-7",
  "1e-6",
  "1e20",
  "1e21",
  "9007199254740993",
  "5e-324",
  "2.2250738585072014e-308",
  "1.7976931348623157e308",
  "123456789012345678901234567890",
  "-0.0000000000000000000000001",
  "true",
  "false",
  "null",
  '"\\ud800"',
  '"\\udfff"',
].entries())
  add(`literal-${index}`, text, prototypeKeys);
let state = 0x12345678;
const bytes = new ArrayBuffer(8);
const view = new DataView(bytes);
for (let index = 0; index < 256; index++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  view.setUint32(0, state);
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  view.setUint32(4, state);
  const value = view.getFloat64(0);
  if (Number.isFinite(value)) add(`number-bit-corpus-${index}`, String(value));
}
for (const [index, text] of [
  "",
  "undefined",
  "[1,]",
  '{"x":1,}',
  '{"x":0x2}',
  '{"x":+1}',
  "{'x':1}",
  '{"x":"\\x41"}',
  "{}[]",
  "\ufeff{}",
  "[NaN]",
  "[Infinity]",
  '{"unclosed":',
  "// comment\n{}",
  '{"x":.2}',
  '{"x":2.}',
  "[01]",
  '"line\nraw"',
  '"\\uqqqq"',
  "/* unclosed",
  "[true false]",
].entries())
  add(`malformed-json-${index}`, text);
const expected = cases.map(reference);
const first = expected[0].output;
assert.ok(isRecord(first));
assert.deepEqual(first.keys, [
  "0",
  "2",
  "10",
  "4294967294",
  "tail",
  "01",
  "4294967295",
  "__proto__",
  "constructor",
  "\ud800",
  "infinite",
  "negative",
]);
const invalid = [
  "not json",
  JSON.stringify({
    id: "missing-input",
    operation: "code_graph.json",
    input: {},
  }),
  JSON.stringify({
    id: "unsupported",
    operation: "invented",
    input: { text: "{}" },
  }),
  JSON.stringify({
    id: "invalid-keys",
    operation: "code_graph.json",
    input: { text: "{}", keys: [1] },
  }),
  JSON.stringify({
    id: "unknown-input",
    operation: "code_graph.json",
    input: { text: "{}", ignored: true },
  }),
];
const native = spawnSync(binary, [], {
  input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
assert.equal(native.status, 0, native.stderr);
assert.equal(native.stderr, "");
const actual = native.stdout
  .trim()
  .split("\n")
  .map((line) => ResultSchema.parse(JSON.parse(line)));
assert.equal(actual.length, cases.length + invalid.length);
for (const [index, answer] of expected.entries()) {
  assert.equal(
    actual[index].ok,
    answer.ok,
    `${cases[index].id}: ${JSON.stringify(actual[index].error)}`,
  );
  if (answer.ok)
    assert.deepEqual(actual[index].output, answer.output, cases[index].id);
  else assert.ok(actual[index].error?.message);
  assert.ok(
    actual[index].observedCalls.includes(
      "demlik_code_graph::text::JsValue::parse",
    ),
  );
}
for (const answer of actual.slice(cases.length)) {
  assert.equal(answer.ok, false);
  assert.ok(answer.error?.message);
  assert.deepEqual(answer.observedCalls, []);
}
const evidence = {
  reference: {
    node: process.version,
    v8: process.versions.v8,
    numberSerialization: "ryu-js 1.0.3",
    pristineObjectPrototypeKeys: prototypeKeys,
  },
  passed: cases.length,
  rejectedInvalidInputs: invalid.length,
  nativeApis: [
    ...new Set(actual.flatMap((answer) => answer.observedCalls)),
  ].sort(),
  cases: actual,
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
