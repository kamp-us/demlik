import { z } from "zod";

const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const message = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "post"]), by: number }).strict(),
  z.object({ op: z.enum(["noop", "finish", "unknown"]) }).strict(),
  z
    .object({ op: z.literal("reuse"), index: z.number().int().nonnegative() })
    .strict(),
]);
const common = {
  runs: z.number().int().min(0).max(200).optional(),
  form: z.enum(["reducer", "transitions"]),
  loaded: z.object({ n: number, done: z.boolean() }).strict().optional(),
  initDelta: number,
  bootCommand: z.boolean(),
  terminalRefuses: z.boolean(),
  fail: z.enum(["init", "subs", "update"]).optional(),
  predicate: z
    .object({
      kind: z.enum(["true", "false", "error"]),
      at: z.number().int().nonnegative(),
    })
    .strict(),
};
export const pbtPropertyScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("property"),
      ...common,
      messages: z.array(message),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sequence"),
      ...common,
      tail: z.number().int().min(0).max(30),
      prefix: z.number().int().min(0).max(3),
    })
    .strict(),
]);
export type PbtPropertyScript = z.infer<typeof pbtPropertyScript>;
export function pbtPropertyCases() {
  const cases: { id: string; input: PbtPropertyScript }[] = [];
  const base = {
    kind: "property",
    form: "reducer",
    initDelta: 0,
    bootCommand: true,
    terminalRefuses: false,
    predicate: { kind: "true", at: 0 },
    runs: 1,
    messages: [{ op: "add", by: 2 }, { op: "noop" }, { op: "add", by: 4 }],
  } as const;
  for (const form of ["reducer", "transitions"] as const) {
    for (const [name, extra] of [
      ["complete-before-check", {}],
      ["empty", { messages: [] }],
      ["one", { messages: [{ op: "add", by: 3 }] }],
      [
        "terminal-following",
        {
          messages: [
            { op: "add", by: 1 },
            { op: "finish" },
            { op: "post", by: 8 },
            { op: "noop" },
          ],
        },
      ],
      [
        "shared-message",
        {
          messages: [
            { op: "add", by: 3 },
            { op: "reuse", index: 0 },
            { op: "noop" },
          ],
        },
      ],
      ["false-first", { predicate: { kind: "false", at: 0 } }],
      ["false-later", { predicate: { kind: "false", at: 2 } }],
      ["original-error-first", { predicate: { kind: "error", at: 0 } }],
      ["original-error-later", { predicate: { kind: "error", at: 2 } }],
      ["init-error", { fail: "init" }],
      ["subs-error", { fail: "subs" }],
      ["update-error", { fail: "update" }],
      [
        "fold-refusal-precedes-false",
        {
          messages: [{ op: "add", by: 2 }, { op: "unknown" }],
          predicate: { kind: "false", at: 0 },
        },
      ],
      ["refusal-first", { messages: [{ op: "unknown" }] }],
      [
        "loaded-transform-resume",
        { loaded: { n: 5, done: false }, initDelta: 10 },
      ],
      [
        "loaded-terminal",
        { loaded: { n: 5, done: true }, messages: [{ op: "post", by: 2 }] },
      ],
      [
        "nonfinite",
        {
          loaded: { n: { $number: "Infinity" }, done: false },
          messages: [
            { op: "add", by: { $number: "-Infinity" } },
            { op: "noop" },
          ],
        },
      ],
      [
        "negative-zero",
        {
          loaded: { n: { $number: "-0" }, done: false },
          messages: [{ op: "noop" }],
        },
      ],
    ] as const)
      cases.push({
        id: `pbt-property.${form}.${name}`,
        input: pbtPropertyScript.parse({ ...base, form, ...extra }),
      });
  }
  cases.push({
    id: "pbt-property.transitions.terminal-refusal",
    input: pbtPropertyScript.parse({
      ...base,
      form: "transitions",
      terminalRefuses: true,
      messages: [{ op: "finish" }, { op: "post", by: 2 }],
    }),
  });
  for (const runs of [0, 3, undefined])
    cases.push({
      id: `pbt-property.count.${runs ?? "default-200"}`,
      input: pbtPropertyScript.parse({ ...base, runs }),
    });
  const { messages: _messages, ...sequenceBase } = base;
  for (const tail of [0, 1, 3, 30])
    for (const prefix of [0, 1, 3])
      cases.push({
        id: `pbt-sequence.tail-${tail}.prefix-${prefix}`,
        input: pbtPropertyScript.parse({
          ...sequenceBase,
          kind: "sequence",
          tail,
          prefix,
        }),
      });
  return cases;
}
