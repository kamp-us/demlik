export type NumberInput =
  | number
  | { $number: "NaN" | "Infinity" | "-Infinity" | "-0" };
export type TextInput = string | { $utf16: number[] };
export type ValueSpec =
  | { type: "undefined" | "null" }
  | { type: "bool"; value: boolean }
  | { type: "number"; value: NumberInput }
  | { type: "text"; value: TextInput }
  | { type: "object" | "array" | "function"; n: NumberInput };
export type FixedScript =
  | { kind: "constant"; tag: string; draws: number }
  | {
      kind: "record";
      tag: string;
      draws: number;
      values: ValueSpec[];
      value?: number;
      extra?: number;
      post?: { slot: number; n: NumberInput }[];
    };
export type InvoiceOp =
  | "start"
  | "tick"
  | "unpaid"
  | "paid"
  | "error"
  | "noop"
  | "unknown";
export type InvoiceScript = {
  kind: "invoice";
  loaded: "fresh" | "done" | "gaveUp";
  before: InvoiceOp[];
  prefix: InvoiceOp[];
  tail: InvoiceOp;
  repeat: number;
  rule: "provenance" | "done" | "gaveUp" | "false" | "error";
  at: NumberInput;
};
export type ConstructorScript = FixedScript | InvoiceScript;
export function pbtConstructorCases(): {
  id: string;
  input: ConstructorScript;
}[] {
  const cases: { id: string; input: ConstructorScript }[] = [];
  const tags = [
    ["stop", "stop"],
    ["empty", ""],
    ["numeric", "2"],
    ["proto", "__proto__"],
    ["inherited-name", "toString"],
    ["colon", "invoice:Tick"],
    ["turkish", "Türkçe"],
    ["astral", "🙂"],
  ];
  for (const [id, tag] of tags)
    cases.push({
      id: `constructors.constant.${id}`,
      input: { kind: "constant", tag, draws: 3 },
    });
  const values: ValueSpec[] = [
    { type: "undefined" },
    { type: "null" },
    { type: "bool", value: false },
    { type: "bool", value: true },
    { type: "number", value: 0 },
    { type: "number", value: { $number: "-0" } },
    { type: "number", value: { $number: "NaN" } },
    { type: "number", value: { $number: "Infinity" } },
    { type: "number", value: { $number: "-Infinity" } },
    { type: "text", value: "" },
    { type: "text", value: "invoice-42" },
    { type: "text", value: { $utf16: [0xd800, 120] } },
    { type: "object", n: 7 },
    { type: "array", n: 8 },
    { type: "function", n: 9 },
  ];
  for (let i = 0; i < values.length; i++) {
    cases.push({
      id: `constructors.record.value-${i}`,
      input: { kind: "record", tag: "result", draws: 3, values, value: i },
    });
    cases.push({
      id: `constructors.record.extra-${i}`,
      input: { kind: "record", tag: "result", draws: 3, values, extra: i },
    });
    cases.push({
      id: `constructors.record.both-${i}`,
      input: {
        kind: "record",
        tag: "result",
        draws: 3,
        values,
        value: i,
        extra: 12,
      },
    });
  }
  cases.push({
    id: "constructors.record.empty",
    input: { kind: "record", tag: "result", draws: 3, values },
  });
  for (const i of [13, 14])
    cases.push({
      id: `constructors.record.alias-${i}`,
      input: {
        kind: "record",
        tag: "result",
        draws: 3,
        values,
        value: i,
        extra: i,
      },
    });
  for (const [slot, n] of [
    [12, 99.25],
    [13, { $number: "-0" }],
    [14, { $number: "NaN" }],
  ] satisfies [number, NumberInput][])
    cases.push({
      id: `constructors.record.mutation-${slot}`,
      input: {
        kind: "record",
        tag: "result",
        draws: 3,
        values,
        value: slot,
        extra: slot,
        post: [{ slot, n }],
      },
    });
  for (const [id, tag] of tags.slice(1, 4))
    cases.push({
      id: `constructors.record.tag-${id}`,
      input: { kind: "record", tag, draws: 3, values, value: 12 },
    });
  cases.push({
    id: "constructors.record.both-undefined",
    input: {
      kind: "record",
      tag: "result",
      draws: 3,
      values,
      value: 0,
      extra: 0,
    },
  });
  cases.push({
    id: "constructors.record.null-and-undefined",
    input: {
      kind: "record",
      tag: "result",
      draws: 3,
      values,
      value: 1,
      extra: 0,
    },
  });
  const recipes: {
    name: string;
    loaded: InvoiceScript["loaded"];
    before: InvoiceOp[];
    prefix: InvoiceOp[];
    tail: InvoiceOp;
    repeat: number;
  }[] = [
    {
      name: "fresh-paid",
      loaded: "fresh",
      before: [],
      prefix: ["start", "tick", "unpaid", "tick", "paid"],
      tail: "noop",
      repeat: 2,
    },
    {
      name: "restored-paid",
      loaded: "fresh",
      before: ["start", "tick", "unpaid"],
      prefix: ["tick", "unpaid", "tick", "paid"],
      tail: "noop",
      repeat: 2,
    },
    {
      name: "repeated-unpaid",
      loaded: "fresh",
      before: ["start", "tick"],
      prefix: ["unpaid"],
      tail: "unpaid",
      repeat: 3,
    },
    {
      name: "restored-done",
      loaded: "fresh",
      before: ["start", "tick", "paid"],
      prefix: ["tick", "noop"],
      tail: "noop",
      repeat: 2,
    },
    {
      name: "fresh-gave-up",
      loaded: "fresh",
      before: [],
      prefix: ["start", "tick", "error"],
      tail: "noop",
      repeat: 2,
    },
    {
      name: "gave-up-restart",
      loaded: "gaveUp",
      before: [],
      prefix: ["start", "tick", "unpaid", "tick", "paid"],
      tail: "noop",
      repeat: 2,
    },
  ];
  for (const recipe of recipes)
    for (const rule of [
      "provenance",
      "false",
      "error",
    ] satisfies InvoiceScript["rule"][]) {
      cases.push({
        id: `constructors.invoice.${recipe.name}.${rule}`,
        input: {
          kind: "invoice",
          loaded: recipe.loaded,
          before: recipe.before,
          prefix: recipe.prefix,
          tail: recipe.tail,
          repeat: recipe.repeat,
          rule,
          at: 1,
        },
      });
    }
  const completed: [string, number, InvoiceScript["rule"]][] = [
    ["fresh-paid", 1, "done"],
    ["restored-paid", 1, "done"],
    ["restored-done", 1, "done"],
    ["fresh-gave-up", 1, "gaveUp"],
    ["gave-up-restart", 1, "done"],
    ["restored-paid", 17.25, "done"],
  ];
  for (const [name, at, rule] of completed) {
    const recipe = recipes.find((r) => r.name === name);
    if (!recipe) throw new Error("recipe must exist");
    cases.push({
      id: `constructors.invoice.${name}.${rule}.${at}`,
      input: {
        kind: "invoice",
        loaded: recipe.loaded,
        before: recipe.before,
        prefix: recipe.prefix,
        tail: recipe.tail,
        repeat: recipe.repeat,
        rule,
        at,
      },
    });
  }
  for (const [prefix, name] of [
    [["unknown"], "first"],
    [["tick", "paid", "unknown"], "late"],
  ] satisfies [InvoiceOp[], string][])
    cases.push({
      id: `constructors.invoice.refusal-${name}`,
      input: {
        kind: "invoice",
        loaded: "fresh",
        before: ["start", "tick", "unpaid"],
        prefix,
        tail: "noop",
        repeat: 2,
        rule: "provenance",
        at: 1,
      },
    });
  return cases;
}
