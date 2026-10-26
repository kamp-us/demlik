import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { expect, it } from "vitest";
import { __DEV__ } from "../../packages/tea/src/pure/core.js";
import {
  bindMachine,
  expectActiveSubs,
  expectCmdEmitted,
  expectCmdSequence,
  expectFinalState,
  step,
} from "../../packages/tea/src/testing/index.js";

function failure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : undefined,
    ownKeys:
      error !== null &&
      (typeof error === "object" || typeof error === "function")
        ? Reflect.ownKeys(error).map(String)
        : [],
    raw: inspect(error, { depth: null, colors: false, showHidden: true }),
  };
}
it("measures the actual installed Source wrappers and matcher profiles", () => {
  const cases: Record<string, unknown>[] = [];
  function probe(id: string, run: () => unknown) {
    try {
      cases.push({ id, status: "ok", value: run() });
    } catch (error) {
      cases.push({ id, status: "error", failure: failure(error) });
    }
  }
  function final(id: string, actual: unknown, expected: unknown) {
    probe(id, () => {
      const log: string[] = [];
      const machine = {
        init: () => {
          log.push("init");
          return [actual, []];
        },
        update: {},
      };
      Reflect.apply(expectFinalState, undefined, [
        machine,
        { msgs: [], ctx: undefined },
        expected,
      ]);
      return log;
    });
  }
  final("equal.nan", { n: Number.NaN }, { n: Number.NaN });
  final("equal.signed-zero", { n: 0 }, { n: -0 });
  final("equal.own-undefined-versus-missing", { n: undefined }, {});
  final("equal.null-versus-undefined", { n: null }, { n: undefined });
  final(
    "equal.prototype",
    Object.assign(Object.create({ inherited: 7 }), { n: 1 }),
    { n: 1 },
  );
  class Value {
    n = 1;
  }
  final("equal.class-versus-plain", new Value(), { n: 1 });
  const fn = () => true;
  final("equal.same-function", { fn }, { fn });
  final("equal.different-function", { fn }, { fn: () => true });
  final("equal.asymmetric-number", { n: 3 }, { n: expect.any(Number) });
  final("equal.asymmetric-refusal", { n: "3" }, { n: expect.any(Number) });
  final("equal.undefined-array-slot", [undefined], Array(1));
  for (const bound of [false, true]) {
    const form = bound ? "bound" : "free";
    const emitted = [
      { type: "a", n: 1 },
      { type: "b", n: 2 },
      { type: "a", n: 3 },
    ];
    const machine = { init: () => [{ n: 0 }, emitted], update: {} };
    const h = Reflect.apply(bindMachine, undefined, [machine, undefined]);
    for (const [op, expected] of [
      ["contains-middle", emitted[1]],
      ["contains-miss", { type: "b", n: 4 }],
      ["sequence-exact", emitted],
      ["sequence-reordered", [...emitted].reverse()],
      ["sequence-short", emitted.slice(1)],
    ] as const) {
      probe(`${form}.${op}`, () => {
        const contains = op.startsWith("contains");
        if (bound) {
          const f = contains ? h.expectCmdEmitted : h.expectCmdSequence;
          Reflect.apply(f, h, [{ msgs: [] }, expected]);
        } else {
          Reflect.apply(
            contains ? expectCmdEmitted : expectCmdSequence,
            undefined,
            [machine, { msgs: [], ctx: undefined }, expected],
          );
        }
      });
    }
  }
  const access: string[] = [];
  const candidate = (id: string, n: number) => ({
    type: "candidate",
    get n() {
      access.push(id);
      return n;
    },
  });
  probe("contains.observed-access-order", () => {
    const machine = {
      init: () => [
        {},
        [candidate("first", 1), candidate("second", 2), candidate("third", 3)],
      ],
      update: {},
    };
    Reflect.apply(expectCmdEmitted, undefined, [
      machine,
      { msgs: [], ctx: undefined },
      { type: "candidate", n: 2 },
    ]);
    return access;
  });
  for (const [kind, cell] of [
    [
      "mutates-state",
      (s: { n: number }) => {
        s.n++;
        return [s, []];
      },
    ],
    [
      "function-command",
      (s: unknown) => [s, [{ type: "bad", run: () => true }]],
    ],
    ["promise-result", () => Promise.resolve([{}, []])],
    ["non-tuple", () => ({ state: {}, cmds: [] })],
  ] as const) {
    probe(`dev.${kind}`, () => {
      const log: string[] = [];
      const state = { n: 1 };
      const machine = {
        init: () => {
          log.push("init");
          return [{ n: 999 }, []];
        },
        update: { tick: cell },
        subs: [
          {
            type: "never",
            deps: () => {
              log.push("subs");
              return {};
            },
          },
        ],
      };
      try {
        Reflect.apply(step, undefined, [
          machine,
          state,
          { type: "tick" },
          new Proxy(
            {},
            {
              get() {
                throw Error("ctx accessed");
              },
            },
          ),
        ]);
      } catch (error) {
        cases.push({
          id: `dev.${kind}.context`,
          log,
          frozen: Object.isFrozen(state),
        });
        throw error;
      }
    });
  }
  probe("step.no-init-subs-context", () => {
    const log: string[] = [];
    const machine = {
      init: () => {
        throw Error("init called");
      },
      update: {
        add: (s: { n: number }, m: { by: number }) => {
          log.push("cell");
          return [{ n: s.n + m.by }, [{ type: "added" }]];
        },
      },
      subs: [
        {
          type: "never",
          deps: () => {
            throw Error("subs called");
          },
        },
      ],
    };
    const ctx = new Proxy(
      {},
      {
        get() {
          throw Error("ctx accessed");
        },
      },
    );
    const h = Reflect.apply(bindMachine, undefined, [machine, ctx]);
    return {
      free: Reflect.apply(step, undefined, [
        machine,
        { n: 4 },
        { type: "add", by: 2 },
        ctx,
      ]),
      bound: Reflect.apply(h.step, h, [{ n: 4 }, { type: "add", by: 2 }]),
      log,
    };
  });
  probe("assert.full-replay-before-matcher", () => {
    const log: string[] = [];
    const machine = {
      init: () => {
        log.push("init");
        return [{ n: 0 }, [{ type: "boot" }]];
      },
      update: {
        add: (s: { n: number }) => {
          log.push(`cell:${s.n}`);
          return [{ n: s.n + 1 }, [{ type: "added" }]];
        },
      },
      subs: [
        {
          type: "timer",
          deps: () => {
            log.push("subs");
            return {};
          },
        },
      ],
    };
    const expected = {
      get n() {
        log.push("match");
        return 3;
      },
    };
    Reflect.apply(expectFinalState, undefined, [
      machine,
      {
        ctx: undefined,
        msgs: Array.from({ length: 3 }, () => ({ type: "add" })),
      },
      expected,
    ]);
    return log;
  });
  const cause = { code: 17, capability: () => true };
  probe("assert.original-matcher-throw", () => {
    const machine = { init: () => [{ n: 1 }, []], update: {} };
    try {
      Reflect.apply(expectFinalState, undefined, [
        machine,
        { ctx: undefined, msgs: [] },
        {
          get n() {
            throw cause;
          },
        },
      ]);
    } catch (error) {
      return { sameCause: error === cause, failure: failure(error) };
    }
    throw Error("getter was not evaluated");
  });
  probe("assert.refusal-before-matcher", () => {
    const log: string[] = [];
    const machine = {
      init: () => [{ type: "ready", n: 1 }, []],
      update: {},
      subs: [
        {
          type: "timer",
          deps: () => {
            log.push("subs");
            return {};
          },
        },
      ],
    };
    try {
      Reflect.apply(expectFinalState, undefined, [
        machine,
        { ctx: undefined, msgs: [{ type: "unknown" }] },
        {
          get n() {
            log.push("match");
            return 1;
          },
        },
      ]);
    } catch (error) {
      return { log, failure: failure(error) };
    }
    throw Error("missing cell did not refuse");
  });
  for (const bound of [false, true]) {
    probe(`${bound ? "bound" : "free"}.active-subs-order`, () => {
      const machine = {
        init: () => [{}, []],
        update: {},
        subs: [
          { type: "a", deps: () => 1 },
          { type: "b", deps: () => 2 },
        ],
      };
      const h = Reflect.apply(bindMachine, undefined, [machine, undefined]);
      const result = Reflect.apply(h.replay, h, [{ msgs: [] }]);
      assert(
        result !== null &&
          typeof result === "object" &&
          "subs" in result &&
          Array.isArray(result.subs),
      );
      const expected = [...result.subs].reverse();
      if (bound) Reflect.apply(h.expectActiveSubs, h, [{ msgs: [] }, expected]);
      else
        Reflect.apply(expectActiveSubs, undefined, [
          machine,
          { ctx: undefined, msgs: [] },
          expected,
        ]);
    });
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const id of [
    "equal.nan",
    "equal.own-undefined-versus-missing",
    "equal.prototype",
    "equal.class-versus-plain",
    "equal.same-function",
    "equal.asymmetric-number",
    "free.contains-middle",
    "bound.contains-middle",
    "step.no-init-subs-context",
    "assert.full-replay-before-matcher",
  ])
    assert.equal(byId.get(id)?.status, "ok", id);
  for (const id of [
    "equal.signed-zero",
    "equal.null-versus-undefined",
    "equal.different-function",
    "equal.asymmetric-refusal",
    "free.sequence-reordered",
    "bound.sequence-reordered",
    "free.active-subs-order",
    "bound.active-subs-order",
  ])
    assert.equal(byId.get(id)?.status, "error", id);
  const report = {
    runtime: { node: process.version, v8: process.versions.v8 },
    developmentChecks: __DEV__,
    cases,
  };
  const file =
    process.env.TEA_TESTING_PROBE_REPORT ??
    "target/parity/testing-helpers-source-probe.json";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
});

it("records actual Source helper outcomes for the shared action scripts", async () => {
  const { testingHelperCases } = await import("./testing-helpers-cases.mts");
  const { executeTestingHelper } = await import(
    "./testing-helpers-reference.mts"
  );
  const cases = testingHelperCases().map((c) => ({
    ...c,
    ...executeTestingHelper(c.input),
  }));
  const file =
    process.env.TEA_TESTING_SOURCE_REPORT ??
    "target/parity/testing-helpers-reference.json";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ runtime: { node: process.version, v8: process.versions.v8 }, developmentChecks: __DEV__, cases }, null, 2)}\n`,
  );
});
