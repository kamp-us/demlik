import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import type * as FastCheck from "../../packages/tea/node_modules/fast-check";
import { defineMachine, NoCellError } from "../../packages/tea/src/index.js";
import {
  createPoller,
  type PollerState,
} from "../../packages/tea/src/internal/flow/poller/index.js";
import {
  arbConstantMsg,
  arbMsgSequence,
  arbRecordMsg,
  foldEvents,
  propertyTrace,
} from "../../packages/tea/src/pbt/index.js";
import type { InvoiceOp, InvoiceScript } from "./pbt-constructors-cases.mts";
import { numberOf, numberView } from "./pbt-constructors-reference.mts";

const require = createRequire(
  new URL("../../packages/tea/package.json", import.meta.url),
);
const fc: typeof FastCheck = require("fast-check");
export function executeConstructorInvoice(input: InvoiceScript) {
  assert.equal(fc.__version, "3.23.2");
  const log: unknown[] = [],
    checks: unknown[] = [];
  const paid = { paid: true, invoice: "invoice-42", capability: () => 17 },
    unpaid = { paid: false, invoice: "invoice-42", capability: () => 18 };
  const cause = { invoice: "invoice-42", capability: () => 19 };
  const command = {
    type: "poll",
    payload: { invoice: "invoice-42", capability: () => 20 },
  };
  const context = { invoice: "invoice-42", capability: () => 21 };
  type Receipt = typeof paid;
  type State = { type: "invoice"; poll: PollerState<Receipt> };
  type Msg =
    | { type: "start" | "tick" | "noop" | "unknown" }
    | { type: "result"; receipt: Receipt; at: number }
    | { type: "error"; cause: typeof cause; at: number };
  type TraceStep = {
    prev: State;
    msg: Msg;
    next: State;
    cmds: readonly (typeof command)[];
  };
  let runs = 0,
    updates = 0,
    untilCalls = 0;
  const poller = createPoller<State, Receipt>(
    {
      everyMs: 10,
      until: () => {
        untilCalls++;
        return false;
      },
      onTick: () => command,
      retry: { baseMs: 1, factor: 1, capMs: 1, jitter: "none", maxAttempts: 1 },
    },
    () => 0.5,
  );
  const seed: State | null =
    input.loaded === "fresh"
      ? null
      : {
          type: "invoice",
          poll:
            input.loaded === "done"
              ? poller.tickResult(poller.init(), paid, 0, true)[0]
              : poller.tickErr(poller.init(), cause, 0)[0],
        };
  const start = arbConstantMsg("start"),
    tick = arbConstantMsg("tick"),
    noop = arbConstantMsg("noop"),
    unknown = arbConstantMsg("unknown");
  function sample<T>(strategy: FastCheck.Arbitrary<T>): T {
    const values = fc.sample(strategy, { seed: 731, numRuns: 1 });
    assert.equal(values.length, 1);
    return values[0];
  }
  function make(op: InvoiceOp): Msg {
    switch (op) {
      case "start":
        return sample(start);
      case "tick":
        return sample(tick);
      case "noop":
        return sample(noop);
      case "unknown":
        return sample(unknown);
      case "unpaid":
      case "paid":
        return sample(
          arbRecordMsg("result", {
            receipt: fc.constant(op === "paid" ? paid : unpaid),
            at: fc.constant(numberOf(input.at)),
          }),
        );
      case "error":
        return sample(
          arbRecordMsg("error", {
            cause: fc.constant(cause),
            at: fc.constant(numberOf(input.at)),
          }),
        );
    }
  }
  const beforeMessages = input.before.map(make),
    prefix = input.prefix.map(make),
    tail = make(input.tail);
  const messages = sample(
    arbMsgSequence(fc.constant(tail), {
      prefix,
      minLength: input.repeat,
      maxLength: input.repeat,
    }),
  );
  function view(s: State) {
    return {
      phase: s.poll.phase,
      tick: numberView(s.poll.tick),
      nextAt:
        s.poll.phase === "polling"
          ? s.poll.nextAtMs === null
            ? null
            : numberView(s.poll.nextAtMs)
          : null,
      result:
        s.poll.lastResult === undefined
          ? "absent"
          : s.poll.lastResult.paid
            ? "paid"
            : "unpaid",
      resultIdentity:
        s.poll.lastResult === undefined ||
        s.poll.lastResult === paid ||
        s.poll.lastResult === unpaid,
      attempt: numberView(s.poll.retry.attempt),
      errorIdentity:
        s.poll.retry.lastError === undefined ||
        s.poll.retry.lastError === cause,
    };
  }
  function messageView(m: Msg): unknown {
    switch (m.type) {
      case "result":
        return {
          type: m.type,
          receipt: m.receipt.paid ? "paid" : "unpaid",
          receiptIdentity: m.receipt === paid || m.receipt === unpaid,
          invoice: m.receipt.invoice,
          capability: m.receipt.capability(),
          at: numberView(m.at),
        };
      case "error":
        return {
          type: m.type,
          causeIdentity: m.cause === cause,
          invoice: m.cause.invoice,
          capability: m.cause.capability(),
          at: numberView(m.at),
        };
      default:
        return { type: m.type };
    }
  }
  let boot: State | undefined;
  function cell(
    s: State,
    m: Msg,
  ): readonly [State, readonly (typeof command)[]] {
    updates++;
    log.push(["update", s.poll.phase, m.type]);
    const [poll, cmds] = (() => {
      switch (m.type) {
        case "start":
          return poller.start(s.poll, 0);
        case "tick":
          return poller.tick(s.poll);
        case "noop":
          return [s.poll, []] as const;
        case "result":
          return poller.tickResult(s.poll, m.receipt, m.at, m.receipt.paid);
        case "error":
          return poller.tickErr(s.poll, m.cause, m.at);
        case "unknown":
          throw new Error("unknown cell is deliberately absent");
      }
    })();
    return [
      poll === s.poll ? s : { type: "invoice", poll },
      cmds as readonly (typeof command)[],
    ];
  }
  const definition = {
    init: (loaded: State | null, ctx: typeof context) => {
      runs++;
      log.push([
        "init",
        loaded === null ? null : view(loaded),
        ctx === context,
        ctx.capability(),
        ctx.invoice,
      ]);
      boot = loaded ?? { type: "invoice", poll: poller.init() };
      return [boot, [command]] as const;
    },
    update: { start: cell, tick: cell, result: cell, error: cell, noop: cell },
    subs: [
      {
        type: "watch",
        deps: (s: State) => {
          const deadlines = poller.subs(s.poll);
          log.push(["subs", s.poll.phase, deadlines.length]);
          return { deadlines };
        },
      },
    ],
  };
  Object.defineProperty(definition, "__form", { value: "reducer" });
  const machine: unknown = Reflect.apply(defineMachine, undefined, [
    definition,
  ]);
  let held = seed,
    before: unknown = null;
  if (beforeMessages.length) {
    const folded: { finalState: State; steps: readonly TraceStep[] } =
      Reflect.apply(foldEvents, undefined, [
        machine,
        context,
        seed,
        beforeMessages,
      ]);
    held = folded.finalState;
    before = {
      state: view(held),
      messagesOriginal: folded.steps.every(
        (s, i) => s.msg === beforeMessages[i],
      ),
      steps: folded.steps.length,
    };
  }
  const baselineUpdates = updates;
  let lastError:
    | { note: string; cause: typeof cause; snapshot: State }
    | undefined;
  let lastTrace: { steps: readonly TraceStep[]; final: State } | undefined;
  let status = "ok",
    failure: unknown = null,
    retention: unknown = null,
    diagnostics: unknown = null;
  const trace = (steps: readonly TraceStep[], s: State) => {
    log.push(["trace"]);
    lastTrace = { steps, final: s };
    checks.push({
      steps: steps.map((step, i) => ({
        msg: messageView(step.msg),
        prev: view(step.prev),
        next: view(step.next),
        sameState: step.prev === step.next,
        sameInput: step.msg === messages[i],
        commands: step.cmds.map((c) => ({
          invoice: c.payload.invoice,
          capability: c.payload.capability(),
          sameCommand: c === command,
        })),
      })),
      final: view(s),
      sameBoot: s === boot,
      bootIsHeld: held === null ? null : boot === held,
      fullFoldComplete: updates === baselineUpdates + messages.length,
      links: steps.every(
        (step, i) => i === 0 || steps[i - 1].next === step.prev,
      ),
      finalIsLast: steps.length === 0 || steps.at(-1)?.next === s,
    });
    if (input.rule === "error") {
      lastError = { note: context.invoice, cause, snapshot: s };
      throw lastError;
    }
    return input.rule === "provenance"
      ? steps.every((step, i) => step.msg === messages[i])
      : input.rule === "done"
        ? s.poll.phase === "done"
        : input.rule === "gaveUp"
          ? s.poll.phase === "gave_up"
          : false;
  };
  try {
    Reflect.apply(propertyTrace, undefined, [
      machine,
      context,
      fc.constant(messages),
      trace,
      { loaded: held, numRuns: 1, seed: 731 },
    ]);
  } catch (error) {
    const actual =
      error instanceof Error && Object.hasOwn(error, "cause")
        ? Reflect.get(error, "cause")
        : error;
    diagnostics = {
      backendGlobals: fc.readConfigureGlobal(),
      errorEnvelopeProfile:
        "Default fast-check decorates without cause; captured callback owners are separate from its outer Error",
      inspect: inspect(error, { depth: 8, showHidden: true, colors: false }),
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              hasOwnCause: Object.hasOwn(error, "cause"),
              causeIsOriginal: actual === lastError,
            }
          : null,
      callbackError:
        lastError !== undefined
          ? {
              note: lastError.note,
              causeInvoice: lastError.cause.invoice,
              causeCapability: lastError.cause.capability(),
              outerErrorReferencesCallback: actual === lastError,
              originalCause: lastError.cause === cause,
              originalSnapshot: lastError.snapshot === lastTrace?.final,
            }
          : null,
    };
    if (
      actual instanceof NoCellError ||
      (lastTrace === undefined &&
        error instanceof Error &&
        error.message.includes("NoCellError"))
    ) {
      status = "refusal";
      failure = { phase: "fold", kind: "refusal" };
    } else if (lastError !== undefined && lastTrace && error instanceof Error) {
      status = "callback";
      failure = { phase: "trace", kind: "error" };
      retention = {
        traceOwners:
          lastTrace.steps.every((step, i) => step.msg === messages[i]) &&
          (lastTrace.steps.length === 0 ||
            lastTrace.steps.at(-1)?.next === lastTrace.final),
      };
    } else if (input.rule === "false" && lastTrace && error instanceof Error) {
      status = "false";
      failure = { phase: "trace", kind: "false" };
      retention = {
        traceOwners:
          lastTrace.steps.every((step, i) => step.msg === messages[i]) &&
          (lastTrace.steps.length === 0 ||
            lastTrace.steps.at(-1)?.next === lastTrace.final),
      };
    } else throw error;
  }
  return {
    comparison: {
      status,
      before,
      messages: messages.map(messageView),
      sameMessageOwners: messages.map((m) => messages.map((n) => m === n)),
      runs,
      updates,
      log,
      checks,
      failure,
      retention,
      untilCalls,
    },
    diagnostics,
  };
}
