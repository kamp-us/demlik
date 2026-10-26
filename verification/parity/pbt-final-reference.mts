import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import type * as FastCheck from "../../packages/tea/node_modules/fast-check";
import { defineMachine } from "../../packages/tea/src/index.js";
import {
  createPoller,
  type PollerState,
} from "../../packages/tea/src/internal/flow/poller/index.js";
import {
  propertyTerminates,
  propertyTrace,
} from "../../packages/tea/src/pbt/index.js";
import type { PbtInvoiceScript } from "./pbt-final-cases.mts";

const require = createRequire(
  new URL("../../packages/tea/package.json", import.meta.url),
);
const fc: typeof FastCheck = require("fast-check");
export function executePbtInvoice(input: PbtInvoiceScript) {
  const log: unknown[] = [],
    checks: unknown[] = [];
  const paid = { paid: true, capability: () => 17 },
    unpaid = { paid: false, capability: () => 18 };
  const cause = { capability: () => 19 },
    command = { type: "poll", invoice: "invoice-42", capability: () => 20 };
  let untilCalls = 0,
    runs = 0,
    updates = 0,
    status = "ok",
    failure: unknown = null,
    originalCallbackSeen = false;
  type Receipt = typeof paid;
  type State = { type: "invoice"; poll: PollerState<Receipt> };
  type Msg = {
    type: (typeof input.events)[number];
    receipt: Receipt;
    cause: typeof cause;
  };
  type Step = {
    prev: State;
    msg: Msg;
    next: State;
    cmds: readonly (typeof command)[];
  };
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
  const expected: Msg[] = input.events.map((type) => ({
    type,
    receipt: type === "paid" ? paid : unpaid,
    cause,
  }));
  function view(s: State) {
    return {
      phase: s.poll.phase,
      tick: s.poll.tick,
      nextAt: s.poll.phase === "polling" ? s.poll.nextAtMs : null,
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
      attempt: s.poll.retry.attempt,
      errorIdentity:
        s.poll.retry.lastError === undefined ||
        s.poll.retry.lastError === cause,
    };
  }
  function cell(
    s: State,
    m: Msg,
  ): readonly [State, readonly (typeof command)[]] {
    log.push(["update", s.poll.phase, m.type]);
    updates++;
    const [poll, cmds] = (() => {
      switch (m.type) {
        case "start":
          return poller.start(s.poll, 0);
        case "tick":
          return poller.tick(s.poll);
        case "paid":
        case "unpaid":
          return poller.tickResult(s.poll, m.receipt, 1, m.receipt.paid);
        case "error":
          return poller.tickErr(s.poll, m.cause, 1);
        case "noop":
          return [s.poll, []] as const;
        case "unknown":
          throw new Error("not a registered cell");
      }
    })();
    return [
      poll === s.poll ? s : { ...s, poll },
      cmds as readonly (typeof command)[],
    ];
  }
  let boot: State | undefined;
  const definition = {
    init: (loaded: State | null) => {
      runs++;
      log.push(["init", loaded === null ? null : view(loaded)]);
      boot = loaded ?? { type: "invoice", poll: poller.init() };
      return [boot, [command]] as const;
    },
    update: {
      start: cell,
      tick: cell,
      unpaid: cell,
      paid: cell,
      error: cell,
      noop: cell,
    },
    subs: [
      {
        type: "watch",
        deps: (s: State) => {
          const list = poller.subs(s.poll);
          log.push(["subs", s.poll.phase, list.length]);
          return { deadlines: list };
        },
      },
    ],
  };
  Object.defineProperty(definition, "__form", { value: "reducer" });
  const machine: unknown = Reflect.apply(defineMachine, undefined, [
    definition,
  ]);
  const finalView = (s: State) => ({
    state: view(s),
    sameBoot: s === boot,
    fullFoldComplete: updates === runs * expected.length,
  });
  function predicate(s: State, provenance: boolean) {
    const good =
      input.rule === "done"
        ? s.poll.phase === "done"
        : input.rule === "gaveUp"
          ? s.poll.phase === "gave_up"
          : input.rule === "provenance"
            ? provenance
            : false;
    if (input.rule === "error") {
      status = "callback";
      failure = { phase: "predicate" };
      originalCallbackSeen = true;
      throw cause;
    }
    if (!good) {
      status = "false";
      failure = { phase: "predicate" };
    }
    return good;
  }
  const terminal = (s: State) => {
    log.push(["terminal"]);
    checks.push(finalView(s));
    return predicate(s, true);
  };
  const trace = (steps: readonly Step[], s: State) => {
    log.push(["trace"]);
    checks.push({
      steps: steps.map((step, i) => ({
        msg: step.msg.type,
        prev: view(step.prev),
        next: view(step.next),
        commands: step.cmds.map((c) => ({
          invoice: c.invoice,
          sameCommand: c === command,
        })),
        sameState: step.prev === step.next,
        sameInput: step.msg === expected[i],
      })),
      final: finalView(s),
      links: steps.every(
        (step, i) => i === 0 || steps[i - 1].next === step.prev,
      ),
      finalIsLast: steps.length === 0 || steps.at(-1)?.next === s,
    });
    const start = steps.map((step) => step.msg.type).lastIndexOf("start");
    const provenance =
      s.poll.phase !== "done" ||
      (input.loaded === "done" && start < 0) ||
      steps.slice(start + 1).some((step) => step.msg.type === "paid");
    return predicate(s, provenance);
  };
  let diagnostics: unknown = null;
  try {
    Reflect.apply(
      input.check === "terminates" ? propertyTerminates : propertyTrace,
      undefined,
      [
        machine,
        undefined,
        fc.constant(expected),
        input.check === "terminates" ? terminal : trace,
        { loaded: seed, numRuns: input.runs, seed: 42 },
      ],
    );
  } catch (error) {
    if (status === "ok") {
      assert.equal(expected[updates]?.type, "unknown");
      status = "refusal";
      failure = { phase: "fold", msg: "unknown", state: "invoice" };
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
    comparison: { status, runs, updates, log, checks, failure, untilCalls },
    diagnostics,
  };
}
