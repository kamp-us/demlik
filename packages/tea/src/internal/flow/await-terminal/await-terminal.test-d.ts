// Type-level test: `runToTerminal`'s seed takes `run`'s `cancellation` and
// `onError` and still refuses a field `run` does not take. Compiled by `pnpm typecheck`; every
// `@ts-expect-error` must sit on a line that fails.

import type { Machine, NoCtx, OnError, Sub } from "../../../index";
import { runToTerminal } from "./index";

type S = { readonly phase: "idle" | "halted" };
type M = { readonly _tag: "halt" };

declare const machine: Machine<S, M, never, Sub<never>, NoCtx>;
const halted = (s: S): boolean => s.phase === "halted";
declare const signal: AbortSignal;

void runToTerminal(machine, { msgs: [] }, halted);

void runToTerminal(
  machine,
  {
    cancellation: { signal, cancel: (_s: S): M => ({ _tag: "halt" }) },
    msgs: [],
  },
  halted,
);

void runToTerminal(
  machine,
  {
    cancellation: { signal, cancel: () => ({ _tag: "halt" }) },
    msgs: [],
    // @ts-expect-error an unknown seed field does not compile
    label: "x",
  },
  halted,
);

void runToTerminal(
  machine,
  // @ts-expect-error a signal without its cancel does not compile
  { cancellation: { signal }, msgs: [] },
  halted,
);

void runToTerminal(
  machine,
  {
    // @ts-expect-error cancel must return the machine's Msg
    cancellation: { signal, cancel: () => ({ _tag: "nope" }) },
    msgs: [],
  },
  halted,
);

void runToTerminal(
  machine,
  { onError: (_error, _context) => {}, msgs: [] },
  halted,
);

void runToTerminal(
  machine,
  {
    cancellation: { signal, cancel: (_s: S): M => ({ _tag: "halt" }) },
    onError: ((_error: unknown) => {}) satisfies OnError,
    msgs: [],
  },
  halted,
);

void runToTerminal(
  machine,
  {
    // @ts-expect-error onError is a sink of (error, context), not a string
    onError: "log",
    msgs: [],
  },
  halted,
);
