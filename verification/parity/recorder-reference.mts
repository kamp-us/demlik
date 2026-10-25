import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import type { Cmd, Machine, Sub } from "../../packages/tea/src/index.ts";
import {
  breadcrumbsFromTrace,
  parseJSONL,
  recorder,
  type Trace,
  traceAttachment,
} from "../../packages/tea/src/internal/persistence/recorder/index.ts";
import {
  deepEqual,
  replayTrace,
} from "../../packages/tea/src/internal/persistence/trace-replay/index.ts";
import {
  indexPath,
  keyPath,
  typeOf,
  unionKeys,
} from "../../packages/tea/src/internal/persistence/trace-replay/state-walk.ts";
import type { BootingRuntime } from "../../packages/tea/src/runtime-types.ts";
import { decode, errorValue, normalize } from "./timing-clock.mts";

type Msg = { type: string; by?: number; state?: unknown };
type Input = Record<string, unknown>;
function diagnostic(value: unknown): unknown {
  if (typeof value === "function") {
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (descriptor?.value === value) return { $builtin: key };
    }
    throw new Error("unexpected fixture function");
  }
  return normalize(value);
}
function difference(value: ReturnType<typeof replayTrace>["divergence"]) {
  return value
    ? {
        path: normalize(value.path),
        expected: diagnostic(value.expected),
        actual: diagnostic(value.actual),
      }
    : null;
}
function machine(actual?: unknown) {
  let updates = 0;
  const model: Machine<unknown, Msg, Cmd, Sub, undefined> = {
    init: () => {
      throw new Error("replay cannot call init");
    },
    update: {
      add: (state, msg) => {
        updates++;
        const counter = state as { type: string; count: number };
        return [{ ...counter, count: counter.count + (msg.by ?? 0) }, []];
      },
      replace: (_state, msg) => {
        updates++;
        return [actual ?? msg.state, []];
      },
    },
    subs: [
      {
        type: "forbidden",
        deps: () => {
          throw new Error("replay cannot select subscriptions");
        },
      },
    ],
  };
  return { model, updates: () => updates };
}
function parse(text: string) {
  try {
    const trace = parseJSONL<unknown, Msg>(text);
    const attachment = traceAttachment(trace);
    return {
      trace: normalize(trace),
      rewrite: attachment.data,
      attachment,
      sharedMessages: trace.steps?.every((step) =>
        trace.msgs.includes(step.msg),
      ),
      sharedFinal:
        !trace.steps?.length ||
        Object.is(trace.steps.at(-1)?.state, trace.finalState),
    };
  } catch (error) {
    assert.ok(error instanceof Error);
    const marker = ": not valid JSON. ";
    const index = error.message.indexOf(marker);
    if (index >= 0)
      return {
        error: {
          name: error.name,
          message: error.message.slice(0, index + marker.length),
        },
        diagnostic: error.message.slice(index + marker.length),
      };
    return { error: errorValue(error) };
  }
}
function recording(input: Input) {
  const boots = new Set<(state: unknown) => void>();
  const observers = new Set<(msg: Msg, state: unknown) => void>();
  // This fixture supplies only callback ingress. The separate eight-case
  // recorder-runtime suite proves attachment to both real runtime profiles.
  const ingress = {
    onBoot(callback: (state: unknown) => void) {
      boots.add(callback);
      return () => boots.delete(callback);
    },
    observe(callback: (msg: Msg, state: unknown) => void) {
      observers.add(callback);
      return () => observers.delete(callback);
    },
  } as unknown as BootingRuntime<unknown, Msg>;
  let randomCalls = 0;
  const original = Math.random;
  Math.random = () => {
    const index = randomCalls++;
    if (index === 0 && input.reenter) {
      const nested = input.reenter as { msg: Msg; state: unknown };
      for (const callback of observers) callback(nested.msg, nested.state);
    }
    return (input.rng as number[] | undefined)?.[index] ?? 0;
  };
  try {
    const rec = recorder(ingress, {
      sampleRate: input.sampleRate as number | undefined,
      captureSteps: input.captureSteps as boolean | undefined,
    });
    const rows: unknown[] = [];
    for (const action of input.actions as Input[]) {
      switch (action.kind) {
        case "boot":
          for (const callback of boots) callback(action.state);
          break;
        case "step":
          for (const callback of observers)
            callback(action.msg as Msg, action.state);
          break;
        case "stop":
          rec.stop();
          break;
        case "dump":
          try {
            const trace = rec.dump();
            const before = normalize(trace);
            // Mutate only the returned arrays to prove their physical independence.
            (trace.msgs as Msg[]).length = 0;
            if (trace.steps)
              (trace.steps as { msg: Msg; state: unknown }[]).length = 0;
            rows.push({
              kind: "dump",
              trace: before,
              freshArrays: deepEqual(normalize(rec.dump()), before),
            });
          } catch (error) {
            rows.push({ kind: "dump", error: errorValue(error) });
          }
          break;
        case "jsonl":
          try {
            rows.push({ kind: "jsonl", text: rec.toJSONL() });
          } catch (error) {
            rows.push({ kind: "jsonl", error: errorValue(error) });
          }
          break;
        default:
          throw new Error("fixture action");
      }
    }
    return { rows, randomCalls };
  } finally {
    Math.random = original;
  }
}
function execute(input: Input): unknown {
  switch (input.op) {
    case "record":
      return recording(input);
    case "parse":
      return parse(input.text as string);
    case "compare": {
      const { model } = machine();
      const result = replayTrace(model, {
        loaded: {},
        msgs: [{ type: "replace", state: input.actual }],
        finalState: input.expected,
      });
      return {
        equal: deepEqual(input.expected, input.actual),
        divergence: difference(result.divergence),
      };
    }
    case "replay": {
      const { model, updates } = machine();
      try {
        const result = replayTrace(model, input.trace as Trace<unknown, Msg>);
        return {
          matches: result.matches,
          expected: normalize(result.expected),
          actual: normalize(result.actual),
          divergence: difference(result.divergence),
          updates: updates(),
          initCalls: 0,
          subscriptionCalls: 0,
        };
      } catch (error) {
        return {
          error: errorValue(error),
          updates: updates(),
          initCalls: 0,
          subscriptionCalls: 0,
        };
      }
    }
    case "walk":
      return {
        type: typeOf(input.value),
        indexPath: normalize(
          indexPath(input.path as string, input.index as number),
        ),
        keyPath: normalize(keyPath(input.path as string, input.key as string)),
        keys: unionKeys(input.left as Input, input.right as Input).map(
          normalize,
        ),
      };
    case "attachment": {
      const trace = input.trace as Trace<unknown, Msg>;
      const attachment = traceAttachment(trace);
      const breadcrumbs = breadcrumbsFromTrace(trace, {
        limit: input.limit as number | undefined,
      });
      return {
        attachment,
        breadcrumbs: normalize(breadcrumbs),
        rendered: breadcrumbsFromTrace(trace, {
          limit: input.limit as number | undefined,
          serialize: (msg) => `${msg.type}!`,
        }).map((crumb) => normalize(crumb.message)),
        sharedMessages: breadcrumbs.every((crumb) =>
          trace.msgs.includes(crumb.data?.msg as Msg),
        ),
        serializedAttachment: normalize(attachment),
      };
    }
    default:
      throw new Error("fixture operation");
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: string; input: unknown };
  const input = decode(request.input) as Input;
  console.log(JSON.stringify({ id: request.id, result: execute(input) }));
}
