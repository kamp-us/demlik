import { z } from "zod";

const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const command = z
  .object({ name: z.enum(["boot", "added", "fetch"]), n: number })
  .strict();
const sub = z.discriminatedUnion("name", [
  z.object({ name: z.enum(["a", "b"]), n: number }).strict(),
  z.object({ name: z.literal("deadline"), at: number }).strict(),
]);
export const counterState = z.object({ n: number, done: z.boolean() }).strict();
export const counterMsg = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), by: number }).strict(),
  z.object({ kind: z.enum(["noop", "finish", "unknown"]) }).strict(),
]);
const pollerCore = { tick: number, last: z.enum(["none", "pending", "ready"]) };
export const pollerState = z.discriminatedUnion("phase", [
  z
    .object({
      ...pollerCore,
      phase: z.literal("polling"),
      nextAt: z.union([number, z.null()]),
    })
    .strict(),
  z.object({ ...pollerCore, phase: z.literal("done") }).strict(),
  z.object({ ...pollerCore, phase: z.literal("gave_up") }).strict(),
]);
export const pollerMsg = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("begin"), at: number }).strict(),
  z
    .object({
      kind: z.literal("read"),
      value: z.enum(["pending", "ready"]),
      at: number,
    })
    .strict(),
  z.object({ kind: z.enum(["deadline", "unknown"]) }).strict(),
]);
const fail = z.enum(["init", "update", "subs", "matcherError", "matcherPanic"]);
const counterOperation = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("step"), state: counterState, msg: counterMsg })
    .strict(),
  z.object({ kind: z.literal("replay") }).strict(),
  z.object({ kind: z.literal("final"), expected: counterState }).strict(),
  z.object({ kind: z.literal("contains"), expected: command }).strict(),
  z
    .object({ kind: z.literal("commands"), expected: z.array(command) })
    .strict(),
  z.object({ kind: z.literal("subs"), expected: z.array(sub) }).strict(),
]);
const pollerOperation = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("step"), state: pollerState, msg: pollerMsg })
    .strict(),
  z.object({ kind: z.literal("replay") }).strict(),
  z.object({ kind: z.literal("final"), expected: pollerState }).strict(),
  z.object({ kind: z.literal("contains"), expected: command }).strict(),
  z
    .object({ kind: z.literal("commands"), expected: z.array(command) })
    .strict(),
  z.object({ kind: z.literal("subs"), expected: z.array(sub) }).strict(),
]);
export const testingHelperScript = z.discriminatedUnion("scenario", [
  z
    .object({
      scenario: z.literal("counter"),
      bound: z.boolean(),
      form: z.enum(["reducer", "transitions", "disambiguated"]),
      loaded: counterState.optional(),
      delta: number,
      boot: z.boolean(),
      subs: z.number().int().min(0).max(2),
      messages: z.array(counterMsg),
      operation: counterOperation,
      fail: fail.optional(),
    })
    .strict(),
  z
    .object({
      scenario: z.literal("poller"),
      bound: z.boolean(),
      loaded: pollerState.optional(),
      messages: z.array(pollerMsg),
      operation: pollerOperation,
      fail: fail.optional(),
    })
    .strict(),
]);
export type TestingHelperScript = z.infer<typeof testingHelperScript>;
export function testingHelperCases() {
  const cases: { id: string; input: TestingHelperScript }[] = [];
  const put = (id: string, input: unknown) =>
    cases.push({
      id: `testing-helpers.${id}`,
      input: testingHelperScript.parse(input),
    });
  const commands = [
    { name: "boot", n: 0 },
    { name: "added", n: 1 },
    { name: "added", n: 3 },
  ];
  const active = [
    { name: "a", n: 3 },
    { name: "b", n: 3 },
  ];
  for (const bound of [false, true]) {
    const p = bound ? "bound" : "free";
    const base = {
      scenario: "counter",
      bound,
      form: "reducer",
      delta: 0,
      boot: true,
      subs: 2,
      messages: [
        { kind: "add", by: 1 },
        { kind: "add", by: 2 },
      ],
    };
    const op = (name: string, operation: unknown, extra = {}) =>
      put(`${p}.counter.${name}`, { ...base, ...extra, operation });
    op("step", {
      kind: "step",
      state: { n: 4, done: false },
      msg: { kind: "add", by: 2 },
    });
    op("final", { kind: "final", expected: { n: 3, done: false } });
    op("final-mismatch", { kind: "final", expected: { n: 4, done: false } });
    op("contains-middle", { kind: "contains", expected: commands[1] });
    op("contains-miss", {
      kind: "contains",
      expected: { name: "added", n: 4 },
    });
    op("sequence", { kind: "commands", expected: commands });
    op("sequence-reordered", {
      kind: "commands",
      expected: [commands[1], commands[0], commands[2]],
    });
    op("sequence-short", { kind: "commands", expected: commands.slice(1) });
    op("subs", { kind: "subs", expected: active });
    op("subs-reordered", { kind: "subs", expected: [...active].reverse() });
    op("subs-short", { kind: "subs", expected: active.slice(1) });
    op(
      "empty-sequence",
      { kind: "commands", expected: [] },
      { messages: [], boot: false, subs: 0 },
    );
    op(
      "empty-contains",
      { kind: "contains", expected: commands[0] },
      { messages: [], boot: false, subs: 0 },
    );
    op(
      "empty-subs",
      { kind: "subs", expected: [] },
      { messages: [], boot: false, subs: 0 },
    );
    op(
      "loaded",
      {
        kind: "commands",
        expected: [
          { name: "boot", n: 14 },
          { name: "added", n: 15 },
          { name: "added", n: 17 },
        ],
      },
      { loaded: { n: 4, done: false }, delta: 10 },
    );
    op(
      "nan",
      { kind: "final", expected: { n: { $number: "NaN" }, done: false } },
      { messages: [{ kind: "add", by: { $number: "NaN" } }] },
    );
    op("signed-zero", {
      kind: "step",
      state: { n: { $number: "-0" }, done: false },
      msg: { kind: "noop" },
    });
    op(
      "signed-zero-mismatch",
      { kind: "final", expected: { n: { $number: "-0" }, done: false } },
      { messages: [], boot: false },
    );
    for (const form of ["transitions", "disambiguated"]) {
      op(
        `${form}-step`,
        {
          kind: "step",
          state: { n: 4, done: false },
          msg: { kind: "add", by: 2 },
        },
        { form },
      );
      op(
        `${form}-final`,
        { kind: "final", expected: { n: 3, done: true } },
        { form, messages: [...base.messages, { kind: "finish" }] },
      );
    }
    for (const phase of ["init", "update", "subs"]) {
      op(
        `failure-${phase}`,
        { kind: "final", expected: { n: 3, done: false } },
        { fail: phase },
      );
    }
    for (const kind of ["final", "contains", "commands", "subs"]) {
      const expected = {
        final: { n: 3, done: false },
        contains: commands[1],
        commands,
        subs: active,
      }[kind];
      op(
        `${kind}-refusal`,
        { kind, expected },
        { messages: [{ kind: "unknown" }] },
      );
      op(`${kind}-matcher-error`, { kind, expected }, { fail: "matcherError" });
      op(`${kind}-matcher-panic`, { kind, expected }, { fail: "matcherPanic" });
    }
    if (bound) op("replay", { kind: "replay" });
  }
  const full = [
    { kind: "begin", at: 0 },
    { kind: "deadline" },
    { kind: "read", value: "pending", at: 5 },
    { kind: "deadline" },
    { kind: "read", value: "ready", at: 10 },
  ];
  const done = { phase: "done", tick: 2, last: "ready" };
  const mid = { phase: "polling", tick: 1, nextAt: 10, last: "pending" };
  for (const bound of [false, true]) {
    const p = bound ? "bound" : "free";
    const base = { scenario: "poller", bound, messages: full };
    const op = (name: string, operation: unknown, extra = {}) =>
      put(`${p}.poller.${name}`, { ...base, ...extra, operation });
    op("step", {
      kind: "step",
      state: { phase: "polling", tick: 0, nextAt: 5, last: "none" },
      msg: { kind: "deadline" },
    });
    op("final", { kind: "final", expected: done });
    op("final-mismatch", { kind: "final", expected: { ...done, tick: 3 } });
    op("contains", { kind: "contains", expected: { name: "fetch", n: 0 } });
    op("sequence", {
      kind: "commands",
      expected: [
        { name: "fetch", n: 0 },
        { name: "fetch", n: 0 },
      ],
    });
    op("sequence-short", {
      kind: "commands",
      expected: [{ name: "fetch", n: 0 }],
    });
    op("subs-done", { kind: "subs", expected: [] });
    op(
      "subs-mid",
      { kind: "subs", expected: [{ name: "deadline", at: 10 }] },
      { messages: full.slice(0, 3) },
    );
    op(
      "mid-state",
      { kind: "final", expected: mid },
      { messages: full.slice(0, 3) },
    );
    op(
      "loaded",
      { kind: "commands", expected: [{ name: "fetch", n: 0 }] },
      { loaded: mid, messages: full.slice(3) },
    );
    if (bound) {
      op("replay", { kind: "replay" });
      op(
        "replay-loaded",
        { kind: "replay" },
        { loaded: mid, messages: full.slice(3) },
      );
    }
  }
  return cases;
}
