import { z } from "zod";

const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
export const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const item = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["undefined", "null"]) }).strict(),
  z.object({ type: z.literal("bool"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("number"), value: number }).strict(),
  z.object({ type: z.literal("text"), value: text }).strict(),
  z.object({ type: z.enum(["token", "function"]), n: number }).strict(),
]);
const effect = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setInput"), n: number }).strict(),
  z
    .object({
      op: z.literal("setToken"),
      slot: z.number().int().nonnegative(),
      n: number,
    })
    .strict(),
  z
    .object({ op: z.literal("append"), reader: z.number().int().nonnegative() })
    .strict(),
  z
    .object({ op: z.literal("remove"), index: z.number().int().nonnegative() })
    .strict(),
  z.object({ op: z.literal("reverse") }).strict(),
  z
    .object({ op: z.literal("truncate"), len: z.number().int().nonnegative() })
    .strict(),
]);
const readOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("defer") }).strict(),
  z
    .object({
      op: z.enum(["answer", "throw"]),
      slot: z.number().int().nonnegative(),
    })
    .strict(),
]);
const reader = z
  .object({
    name: text,
    action: readOp,
    effects: z.array(effect).default([]),
    mutateOn: z.number().int().nonnegative().default(0),
  })
  .strict();
export const composeScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("read"),
      input: z.object({ n: number }).strict(),
      values: z.array(item),
      readers: z.array(reader),
      order: z.array(z.number().int().nonnegative()),
      absent: z.number().int().nonnegative(),
      direct: z.number().int().nonnegative().optional(),
      post: z.array(effect).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("lift"),
      field: z.enum(["left", "right"]),
      sameSlice: z.boolean(),
      nextSlot: z.number().int().nonnegative(),
      commands: z.array(z.number().int().nonnegative()),
      values: z.array(item),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow"),
      values: z.array(item),
      messages: z.array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("ask"), key: text, at: number }).strict(),
          z
            .object({
              op: z.literal("arrive"),
              key: text,
              slot: z.number().int().nonnegative(),
            })
            .strict(),
          z.object({ op: z.literal("unknown") }).strict(),
        ]),
      ),
      queries: z.array(text),
      reversed: z.boolean(),
      bootCommand: z.boolean(),
      loaded: z
        .object({
          cache: z.array(
            z
              .object({ key: text, slot: z.number().int().nonnegative() })
              .strict(),
          ),
          pending: z.array(z.object({ key: text, at: number }).strict()),
          asked: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ComposeScript = z.infer<typeof composeScript>;
export function composeCases() {
  const cases: { id: string; input: ComposeScript }[] = [];
  const add = (id: string, input: unknown) =>
    cases.push({ id, input: composeScript.parse(input) });
  const values = [
    { type: "undefined" },
    { type: "null" },
    { type: "bool", value: false },
    { type: "number", value: 0 },
    { type: "number", value: { $number: "-0" } },
    { type: "number", value: { $number: "NaN" } },
    { type: "text", value: "" },
    { type: "token", n: 7 },
    { type: "function", n: 8 },
    { type: "text", value: { $utf16: [55296, 120] } },
    { type: "number", value: { $number: "Infinity" } },
  ];
  const base = {
    kind: "read",
    input: { n: 0 },
    values,
    readers: [],
    order: [],
    absent: 7,
  };
  const R = (
    op: string,
    slot?: number,
    extra: Record<string, unknown> = {},
  ) => ({
    name: op,
    action: slot === undefined ? { op } : { op, slot },
    ...extra,
  });
  for (let slot = 0; slot < values.length; slot++) {
    add(`compose.read.answer-${slot}`, {
      ...base,
      readers: [R("answer", slot), R("throw", 8)],
      order: [0, 1],
    });
    add(`compose.read.error-${slot}`, {
      ...base,
      readers: [R("defer"), R("throw", slot), R("answer", 7)],
      order: [0, 1, 2],
    });
    add(`compose.read.direct-${slot}`, {
      ...base,
      readers: [R("answer", slot)],
      order: [],
      direct: 0,
      absent: 0,
    });
  }
  for (const absent of [0, 1, 2, 7, 8])
    for (const order of [[], [0, 1]])
      add(`compose.read.absent-${absent}.${order.length}`, {
        ...base,
        absent,
        readers: [R("defer"), R("defer")],
        order,
      });
  for (const first of ["defer", "answer", "throw"])
    for (const second of ["defer", "answer", "throw"])
      add(`compose.read.precedence.${first}.${second}`, {
        ...base,
        readers: [
          R(first, first === "defer" ? undefined : 2),
          R(second, second === "defer" ? undefined : 8),
        ],
        order: [0, 1],
      });
  add("compose.read.undefined-only-defers", {
    ...base,
    readers: [R("answer", 0), R("answer", 1), R("throw", 8)],
    order: [0, 1, 2],
  });
  add("compose.read.receiver-utf16", {
    ...base,
    readers: [R("answer", 7, { name: { $utf16: [55296, 65, 56320] } })],
    order: [0],
  });
  add("compose.read.live-append", {
    ...base,
    readers: [
      R("defer", undefined, { effects: [{ op: "append", reader: 1 }] }),
      R("answer", 7),
    ],
    order: [0],
  });
  add("compose.read.live-remove", {
    ...base,
    readers: [
      R("defer", undefined, { effects: [{ op: "remove", index: 1 }] }),
      R("throw", 8),
      R("answer", 7),
    ],
    order: [0, 1, 2],
  });
  add("compose.read.live-reverse-revisit", {
    ...base,
    readers: [
      R("defer", undefined, { effects: [{ op: "reverse" }] }),
      R("throw", 8),
    ],
    order: [0, 1],
  });
  add("compose.read.live-truncate", {
    ...base,
    readers: [
      R("defer", undefined, { effects: [{ op: "truncate", len: 0 }] }),
      R("throw", 8),
    ],
    order: [0, 1],
  });
  add("compose.read.live-shared-reader", {
    ...base,
    readers: [
      R("defer", undefined, {
        effects: [
          { op: "append", reader: 1 },
          { op: "append", reader: 1 },
        ],
      }),
      R("defer", undefined, { effects: [{ op: "setInput", n: 22 }] }),
    ],
    order: [0],
  });
  add("compose.read.same-input-mutated", {
    ...base,
    readers: [
      R("defer", undefined, {
        effects: [{ op: "setInput", n: { $number: "-0" } }],
      }),
      R("answer", 7),
    ],
    order: [0, 1],
  });
  for (const op of ["answer", "throw"])
    for (const slot of [7, 8])
      add(`compose.read.retained-${op}-${slot}`, {
        ...base,
        readers: [R(op, slot)],
        order: [0],
        post: [{ op: "setToken", slot, n: 19 }],
      });
  add("compose.read.mutate-before-answer", {
    ...base,
    readers: [
      R("defer", undefined, {
        effects: [{ op: "setToken", slot: 7, n: { $number: "NaN" } }],
      }),
      R("answer", 7),
    ],
    order: [0, 1],
  });
  for (const field of ["left", "right"])
    for (const sameSlice of [false, true])
      for (const nextSlot of sameSlice
        ? [field === "left" ? 0 : 1]
        : [0, 1, 2, 4, 5, 7, 8, 9])
        for (const commands of [[], [7, 8, 7]])
          add(
            `compose.lift.${field}.${sameSlice}.${nextSlot}.${commands.length}`,
            { kind: "lift", field, sameSlice, nextSlot, commands, values },
          );
  const w = {
    kind: "workflow",
    values: [
      { type: "token", n: 7 },
      { type: "function", n: 8 },
    ],
    messages: [],
    queries: ["invoice-42", "missing"],
    reversed: false,
    bootCommand: true,
  };
  const histories = [
    ["empty", []],
    ["pending", [{ op: "ask", key: "invoice-42", at: 7 }]],
    [
      "arrived",
      [
        { op: "ask", key: "invoice-42", at: 7 },
        { op: "arrive", key: "invoice-42", slot: 0 },
      ],
    ],
    [
      "refresh",
      [
        { op: "ask", key: "invoice-42", at: 7 },
        { op: "arrive", key: "invoice-42", slot: 0 },
        { op: "ask", key: "invoice-42", at: 9 },
      ],
    ],
    [
      "replacement",
      [
        { op: "ask", key: "invoice-42", at: 7 },
        { op: "arrive", key: "invoice-42", slot: 0 },
        { op: "ask", key: "invoice-42", at: 9 },
        { op: "arrive", key: "invoice-42", slot: 1 },
      ],
    ],
    [
      "two-keys",
      [
        { op: "ask", key: "invoice-42", at: 7 },
        { op: "ask", key: "missing", at: 8 },
        { op: "arrive", key: "invoice-42", slot: 0 },
        { op: "ask", key: "invoice-42", at: 9 },
      ],
    ],
    ["refused-first", [{ op: "unknown" }]],
    [
      "refused-later",
      [
        { op: "ask", key: "invoice-42", at: 7 },
        { op: "arrive", key: "invoice-42", slot: 0 },
        { op: "unknown" },
      ],
    ],
  ] as const;
  for (const reversed of [false, true])
    for (const [name, messages] of histories)
      add(`compose.workflow.${name}.${reversed}`, { ...w, messages, reversed });
  for (const reversed of [false, true])
    add(`compose.workflow.restored-refresh.${reversed}`, {
      ...w,
      reversed,
      loaded: {
        cache: [{ key: "invoice-42", slot: 1 }],
        pending: [{ key: "invoice-42", at: 3 }],
        asked: 4,
      },
      messages: [
        { op: "ask", key: "invoice-42", at: 9 },
        { op: "arrive", key: "invoice-42", slot: 0 },
        { op: "ask", key: "invoice-42", at: 10 },
      ],
    });
  return cases;
}
