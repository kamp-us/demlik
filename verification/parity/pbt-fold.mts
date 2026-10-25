import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { defineMachine, NoCellError } from "../../packages/tea/src/index.js";
import { foldEvents } from "../../packages/tea/src/pbt/index.js";
import {
  executePbtIntake,
  pbtIntakeCases,
  pbtIntakeScript,
} from "./pbt-intake.mts";
import { normalize, numeric } from "./timing-clock.mts";

const num = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const msg = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "post"]), by: num }).strict(),
  z.object({ op: z.enum(["noop", "finish", "explode", "unknown"]) }).strict(),
  z
    .object({ op: z.literal("reuse"), index: z.number().int().nonnegative() })
    .strict(),
]);
const counter = z
  .object({
    kind: z.literal("counter"),
    form: z.enum(["reducer", "transitions", "disambiguated"]),
    loaded: z.object({ done: z.boolean(), n: num }).strict().optional(),
    initDelta: num,
    bootCommand: z.boolean(),
    subs: z.number().int().min(0).max(2),
    fail: z.enum(["init", "subs", "update"]).optional(),
    terminalRefuses: z.boolean(),
    messages: z.array(msg),
  })
  .strict();
export const pbtFoldScript = z.discriminatedUnion("kind", [
  counter,
  pbtIntakeScript,
]);
type Counter = z.infer<typeof counter>;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function record(v: unknown): Record<string, unknown> {
  assert(object(v));
  return v;
}
const folded = z
  .object({
    states: z.array(z.unknown()),
    steps: z.array(
      z
        .object({
          prev: z.unknown(),
          msg: z.unknown(),
          next: z.unknown(),
          cmds: z.array(z.unknown()),
        })
        .strict(),
    ),
    finalState: z.unknown(),
  })
  .strict();
function ids() {
  const map = new WeakMap<object, number>();
  let next = 0;
  return (v: unknown) => {
    assert(v !== null && (typeof v === "object" || typeof v === "function"));
    const found = map.get(v);
    if (found !== undefined) return found;
    map.set(v, next);
    return next++;
  };
}
function executeCounter(input: Counter) {
  const log: unknown[] = [],
    payload = { counter: "shared" },
    cause = { phase: input.fail ?? "update", code: 17, capability: () => true };
  const loaded = input.loaded
    ? {
        type: input.loaded.done ? "done" : "active",
        n: numeric.parse(input.loaded.n),
        payload,
      }
    : null;
  const messages: Record<string, unknown>[] = [];
  for (const a of input.messages) {
    if (a.op === "reuse") {
      assert(messages[a.index]);
      messages.push(messages[a.index]);
    } else {
      messages.push({
        type: a.op,
        by: "by" in a ? numeric.parse(a.by) : undefined,
        payload,
      });
    }
  }
  function cell(
    state: { type: string; n: number; payload: object },
    m: { type: string; by?: number; payload: object },
  ) {
    log.push(["cell", state.type, normalize(state.n), m.type]);
    if (input.fail === "update" || m.type === "explode") throw cause;
    if (m.type === "noop") return [state, []];
    if (m.type === "finish") return [{ ...state, type: "done" }, []];
    const n = state.n + (m.by ?? 0);
    return [
      { ...state, n, payload: m.payload },
      [{ type: "observed", n, payload: m.payload }],
    ];
  }
  const row = {
    add: cell,
    noop: cell,
    finish: cell,
    post: cell,
    explode: cell,
  };
  const transitionRow = () =>
    input.form === "disambiguated"
      ? Object.assign(function rowContainer() {
          throw Error("must honor stamped form");
        }, row)
      : row;
  const def = {
    init: (saved: typeof loaded) => {
      log.push(["init", normalize(saved)]);
      if (input.fail === "init") throw cause;
      let state = saved ?? { type: "active", n: 0, payload };
      const delta = numeric.parse(input.initDelta);
      if (delta !== 0) state = { ...state, n: state.n + delta };
      return [
        state,
        input.bootCommand
          ? [{ type: "boot", n: state.n, payload: state.payload }]
          : [],
      ];
    },
    update:
      input.form === "reducer"
        ? row
        : {
            active: transitionRow(),
            done: input.terminalRefuses ? {} : transitionRow(),
          },
    subs: Array.from({ length: input.subs }, (_, index) => ({
      type: "watch",
      deps: (state: { type: string; n: number }) => {
        log.push(["subs", index, state.type, normalize(state.n)]);
        if (input.fail === "subs") throw cause;
        return { n: state.n };
      },
    })),
  };
  Object.defineProperty(def, "__form", {
    value: input.form === "reducer" ? "reducer" : "transitions",
    enumerable: false,
  });
  // Reflect crosses the deliberately dynamic wire/form fixtures, including
  // an unknown message and function-valued rows with authoritative __form.
  const machine: unknown = Reflect.apply(defineMachine, undefined, [def]);
  try {
    const result = folded.parse(
      Reflect.apply(foldEvents, undefined, [
        machine,
        undefined,
        loaded,
        messages,
      ]),
    );
    const stateId = ids(),
      msgId = ids();
    if (loaded) stateId(loaded);
    const inputMsgIds = messages.map(msgId),
      stateIds = result.states.map(stateId);
    return {
      status: "ok",
      log,
      inputMsgIds,
      states: result.states.map((s, i) => ({
        id: stateIds[i],
        value: normalize(s),
        samePayload: record(s).payload === payload,
      })),
      steps: result.steps.map((s, i) => ({
        prev: stateId(s.prev),
        next: stateId(s.next),
        msgId: msgId(s.msg),
        msg: normalize(s.msg),
        commands: s.cmds.map((c) => ({
          ...record(normalize(c)),
          samePayload: record(c).payload === payload,
        })),
        sameState: s.prev === s.next,
        sameMsg: s.msg === messages[i],
        prevLink: s.prev === result.states[i],
        nextLink: s.next === result.states[i + 1],
      })),
      final: stateId(result.finalState),
      finalLink: result.finalState === result.states.at(-1),
    };
  } catch (error) {
    if (error instanceof NoCellError)
      return {
        status: "error",
        log,
        error: {
          kind: "refusal",
          value: {
            name: error.name,
            _tag: error._tag,
            message: error.message,
            msgType: error.msgType,
            stateName: error.stateName,
            acceptedTypes: error.acceptedTypes,
          },
        },
      };
    assert.equal(error, cause);
    return {
      status: "error",
      log,
      error: {
        kind: "callback",
        sameCause: error === cause,
        phase: cause.phase,
        code: cause.code,
      },
    };
  }
}
export function pbtFoldCases() {
  const cases: { id: string; input: Counter }[] = [];
  const base = {
    kind: "counter",
    initDelta: 0,
    bootCommand: true,
    subs: 2,
    terminalRefuses: false,
  };
  for (const form of ["reducer", "transitions", "disambiguated"] as const) {
    for (const [name, extra] of [
      ["empty-fresh", { messages: [] }],
      [
        "empty-loaded",
        { loaded: { done: false, n: 4 }, initDelta: 10, messages: [] },
      ],
      [
        "ordered-and-terminal",
        {
          messages: [
            { op: "add", by: 2 },
            { op: "noop" },
            { op: "finish" },
            { op: "post", by: 3 },
            { op: "reuse", index: 0 },
          ],
        },
      ],
      [
        "loaded-transform",
        {
          loaded: { done: false, n: 5 },
          initDelta: 10,
          messages: [
            { op: "add", by: 2 },
            { op: "add", by: 4 },
            { op: "noop" },
          ],
        },
      ],
      [
        "no-subs",
        { subs: 0, messages: [{ op: "noop" }, { op: "noop" }, { op: "noop" }] },
      ],
      ["unknown", { messages: [{ op: "add", by: 2 }, { op: "unknown" }] }],
      ["init-error", { fail: "init", messages: [{ op: "add", by: 2 }] }],
      ["subs-error", { fail: "subs", messages: [{ op: "add", by: 2 }] }],
      [
        "update-error",
        { messages: [{ op: "add", by: 2 }, { op: "explode" }, { op: "noop" }] },
      ],
      [
        "negative-zero",
        {
          loaded: { done: false, n: { $number: "-0" } },
          messages: [{ op: "noop" }, { op: "add", by: 0 }],
        },
      ],
      [
        "nonfinite",
        {
          loaded: { done: false, n: { $number: "Infinity" } },
          messages: [
            { op: "add", by: { $number: "-Infinity" } },
            { op: "noop" },
          ],
        },
      ],
    ] as const)
      cases.push({
        id: `pbt-fold.${form}.${name}`,
        input: counter.parse({ ...base, form, ...extra }),
      });
    if (form !== "reducer")
      cases.push({
        id: `pbt-fold.${form}.terminal-refusal`,
        input: counter.parse({
          ...base,
          form,
          terminalRefuses: true,
          messages: [{ op: "finish" }, { op: "post", by: 1 }],
        }),
      });
  }
  return [...cases, ...pbtIntakeCases()];
}
const native = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function pbtFoldParity(options: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const cases = pbtFoldCases().filter(
      (c) => !options.caseIds || options.caseIds.includes(c.id),
    ),
    expected = cases.map((c) =>
      c.input.kind === "counter"
        ? executeCounter(c.input)
        : executePbtIntake(c.input),
    );
  const p = spawnSync(options.binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(p.status, 0, p.stderr);
  const actual = p.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => native.parse(JSON.parse(s)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    try {
      assert.deepEqual(actual[i].comparison, expected[i]);
      return [];
    } catch {
      return [
        { id: c.id, reference: expected[i], native: actual[i].comparison },
      ];
    }
  });
  const report = {
    runtime: { node: process.version, v8: process.versions.v8 },
    binary: {
      path: options.binary,
      sha256: createHash("sha256")
        .update(readFileSync(options.binary))
        .digest("hex"),
    },
    compared: cases.length,
    passed: cases.length - failures.length,
    failures,
    cases: cases.map((c, i) => ({
      ...c,
      ...actual[i],
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Dependency-free foldEvents only; propertyInvariant/generation/shrinking are unfinished.",
      "Source model/payload handles compared with caller-chosen inner Rust shared handles; native trace bookkeeping Arcs are verified separately.",
    ],
  };
  const file = options.reportFile ?? "target/parity/pbt-fold.json";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"]);
  const r = pbtFoldParity({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      compared: r.compared,
      passed: r.passed,
      failures: r.failures,
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
