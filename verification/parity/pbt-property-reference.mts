import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import type * as FastCheck from "../../packages/tea/node_modules/fast-check";
import { defineMachine } from "../../packages/tea/src/index.js";
import {
  arbMsgSequence,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "../../packages/tea/src/pbt/index.js";
import type { PbtPropertyScript } from "./pbt-property-cases.mts";
import { encodeNumber, numeric } from "./timing-clock.mts";

const require = createRequire(
  new URL("../../packages/tea/package.json", import.meta.url),
);
const fc: typeof FastCheck = require("fast-check");
const fastCheckVersion: unknown = require("fast-check/package.json").version;
export function executePbtProperty(
  input: PbtPropertyScript,
  operation: "invariant" | "terminates" | "trace" = "invariant",
) {
  const log: unknown[] = [],
    checks: unknown[] = [],
    payload = { capability: () => 17 };
  const cause = {
    phase: input.fail ?? "invariant",
    code: 17,
    capability: () => 17,
  };
  let runs = 0,
    updates = 0,
    index = 0,
    status = "ok",
    failure: unknown = null,
    originalCallbackSeen = false;
  type State = { type: string; n: number; payload: object };
  type Msg = { type: string; by?: number; payload: object };
  type Cmd = { type: string; n: number; payload: object };
  type Step = { prev: State; msg: Msg; next: State; cmds: readonly Cmd[] };
  let bootState: State | undefined;
  const seed = input.loaded
    ? {
        type: input.loaded.done ? "done" : "active",
        n: numeric.parse(input.loaded.n),
        payload,
      }
    : null;
  const fixed: Msg[] = [];
  if (input.kind === "property")
    for (const msg of input.messages) {
      if (msg.op === "reuse") {
        assert(fixed[msg.index]);
        fixed.push(fixed[msg.index]);
      } else
        fixed.push({
          type: msg.op,
          ...("by" in msg ? { by: numeric.parse(msg.by) } : {}),
          payload,
        });
    }
  const prefix: Msg[] =
    input.kind === "sequence"
      ? Array.from({ length: input.prefix }, () => ({
          type: "add",
          by: 1,
          payload,
        }))
      : [];
  const tail: Msg = { type: "add", by: 2, payload };
  const expected =
    input.kind === "sequence"
      ? [...prefix, ...Array.from({ length: input.tail }, () => tail)]
      : fixed;
  const stateView = (s: State) => ({ type: s.type, n: encodeNumber(s.n) });
  function cell(s: State, m: Msg): [State, Cmd[]] {
    log.push(["update", s.type, encodeNumber(s.n), m.type]);
    updates++;
    if (input.fail === "update") {
      originalCallbackSeen = true;
      throw cause;
    }
    if (m.type === "noop") return [s, []];
    if (m.type === "finish") return [{ ...s, type: "done" }, []];
    const n = s.n + (m.by ?? 0);
    return [
      { ...s, n, payload: m.payload },
      [{ type: "observed", n, payload: m.payload }],
    ];
  }
  const row = { add: cell, finish: cell, noop: cell, post: cell };
  const def = {
    init: (loaded: State | null): [State, Cmd[]] => {
      runs++;
      index = 0;
      log.push(["init", loaded ? stateView(loaded) : null]);
      if (input.fail === "init") {
        originalCallbackSeen = true;
        throw cause;
      }
      let s = loaded ?? { type: "active", n: 0, payload };
      const delta = numeric.parse(input.initDelta);
      if (delta !== 0) s = { ...s, n: s.n + delta };
      bootState = s;
      return [s, input.bootCommand ? [{ type: "boot", n: s.n, payload }] : []];
    },
    update:
      input.form === "reducer"
        ? row
        : { active: row, done: input.terminalRefuses ? {} : row },
    subs: [
      {
        type: "watch",
        deps: (s: State) => {
          log.push(["subs", s.type, encodeNumber(s.n)]);
          if (input.fail === "subs") {
            originalCallbackSeen = true;
            throw cause;
          }
          return { n: s.n };
        },
      },
    ],
  };
  Object.defineProperty(def, "__form", {
    value: input.form,
    enumerable: false,
  });
  // The parsed fixture intentionally includes unknown messages and raw update
  // forms. Reflect crosses that explicit malformed-message test boundary only.
  const machine: unknown = Reflect.apply(defineMachine, undefined, [def]);
  const sequence =
    input.kind === "property"
      ? fc.constant(fixed)
      : arbMsgSequence(fc.constant(tail), {
          minLength: input.tail,
          maxLength: input.tail,
          prefix,
        });
  const stepView = ({ prev, msg, next, cmds }: Step, at: number) => ({
    index: at,
    prev: stateView(prev),
    next: stateView(next),
    msg: {
      type: msg.type,
      ...(msg.by === undefined ? {} : { by: encodeNumber(msg.by) }),
    },
    commands: cmds.map((c) => ({
      type: c.type,
      n: encodeNumber(c.n),
      samePayload: c.payload === payload,
    })),
    sameState: prev === next,
    sameInput: msg === expected[at],
    sameAsPrevious: at > 0 && msg === expected[at - 1],
    samePayload: msg.payload === payload,
    fullFoldComplete: updates === runs * expected.length,
  });
  const finalView = (s: State) => ({
    state: stateView(s),
    samePayload: s.payload === payload,
    sameBoot: s === bootState,
    fullFoldComplete: updates === runs * expected.length,
  });
  const predicate = (at?: number) => {
    if (
      (at === undefined || at === input.predicate.at) &&
      input.predicate.kind !== "true"
    ) {
      failure =
        at === undefined
          ? { phase: "predicate" }
          : { phase: "invariant", step: at };
      if (input.predicate.kind === "error") {
        originalCallbackSeen = true;
        status = "callback";
        throw cause;
      }
      status = "false";
      return false;
    }
    return true;
  };
  const callbacks = {
    invariant: (step: Step) => {
      const at = index++;
      log.push(["check", at]);
      checks.push(stepView(step, at));
      return predicate(at);
    },
    terminates: (s: State) => {
      log.push(["terminal"]);
      checks.push(finalView(s));
      return predicate();
    },
    trace: (steps: readonly Step[], finalState: State) => {
      log.push(["trace"]);
      checks.push({
        steps: steps.map(stepView),
        final: finalView(finalState),
        finalIsLast: steps.length === 0 || steps.at(-1)?.next === finalState,
        links: steps.every((s, i) => i === 0 || steps[i - 1].next === s.prev),
      });
      return predicate();
    },
  };
  const runners = {
    invariant: propertyInvariant,
    terminates: propertyTerminates,
    trace: propertyTrace,
  };
  let diagnostics: unknown = null;
  try {
    Reflect.apply(runners[operation], undefined, [
      machine,
      undefined,
      sequence,
      callbacks[operation],
      {
        loaded: seed,
        ...(input.runs === undefined ? {} : { numRuns: input.runs }),
        seed: 42,
      },
    ]);
  } catch (error) {
    if (status === "ok") {
      const refused = log.at(-1);
      if (originalCallbackSeen) {
        status = "callback";
        failure = { phase: input.fail };
      } else {
        status = "refusal";
        assert(Array.isArray(refused));
        failure = {
          phase: "fold",
          msg: expected[updates]?.type,
          state: input.loaded?.done
            ? "done"
            : expected.slice(0, updates).some((m) => m.type === "finish")
              ? "done"
              : "active",
        };
      }
    }
    diagnostics = {
      type: typeof error,
      inspect: inspect(error, { depth: 8, showHidden: true, colors: false }),
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              hasOwnCause: Object.hasOwn(error, "cause"),
              causeIsOriginal: Reflect.get(error, "cause") === cause,
            }
          : null,
      originalCallbackSeen,
    };
  }
  return {
    comparison: { status, runs, updates, log, checks, failure },
    diagnostics,
    fastCheckVersion,
  };
}
