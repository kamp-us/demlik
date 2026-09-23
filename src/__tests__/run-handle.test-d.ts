// Type-level test for the shared run handle (#281). Compiled by
// `pnpm typecheck`. Each `@ts-expect-error` MUST sit on a line that genuinely
// fails to type-check; every line without one is a positive case.
//
// The contract: `RunHandle` / `BootedRunHandle` come from the core entry point,
// every engine's `run` returns one, and the host helpers take any value of it —
// shown here with handles built by hand, which no engine produced. `useMachine`
// takes the engine's `run` as an option, so an engine that is not the Promise
// one plugs in the same way.

import type { AgentEvent } from "../agent/index";
import {
  bootResume,
  driveProjections,
  projectionRegistry,
  sseFromAgentEvents,
  sseHub,
} from "../do/index";
import {
  type BootedRunHandle,
  type BootingRuntime,
  type Cmd,
  defineMachine,
  type EngineRun,
  type Machine,
  type NoCtx,
  type RunHandle,
  type RunOptions,
  type Runtime,
  type Sub,
} from "../index";
import { run } from "../promise";
import { useMachine, useRuntime } from "../react/index";

type State = { readonly n: number };
type Msg = { readonly type: "inc" } | { readonly type: "resume" };

/** A booted handle built by hand — no engine behind it. */
function fakeHandle<S, M extends { type: string }, E extends { type: string }>(
  state: S,
): BootedRunHandle<S, M, E> {
  const handle: BootedRunHandle<S, M, E> = {
    dispatch: async () => undefined,
    subscribe: () => () => {},
    observe: () => () => {},
    onBoot: () => () => {},
    on: () => () => {},
    getState: () => state,
    get ready() {
      return Promise.resolve(handle);
    },
    stop: async () => undefined,
  };
  return handle;
}

const fake = fakeHandle<State, Msg, never>({ n: 0 });
const fakeAgent = fakeHandle<State, Msg, AgentEvent<string>>({ n: 0 });

// ── Every helper takes the hand-built handle ─────────────────────────────────

export function Viewer(): null {
  const [state, dispatch] = useRuntime(fake);
  const n: number = state.n;
  void n;
  void dispatch({ type: "inc" });
  return null;
}

export const projections = driveProjections(
  projectionRegistry<State, Msg>(),
  fake,
);

export const sse = sseFromAgentEvents(
  fakeAgent,
  sseHub<{ readonly kind: "done" }>(),
  (e) => (e.type === "RunDone" ? { kind: "done" } : null),
);

export const resumed: Promise<void> = bootResume(fake, {
  isResumable: (s) => s.n > 0,
  resumeMsg: () => ({ type: "resume" }),
});

// A booting handle (no `getState`) is enough for `bootResume`, which waits on
// `ready` itself — but not for `useRuntime`, which reads State at once.
declare const booting: RunHandle<State, Msg>;
export const resumedFromBooting: Promise<void> = bootResume(booting, {
  isResumable: () => false,
  resumeMsg: () => ({ type: "resume" }),
});
export function BootingViewer(): null {
  // @ts-expect-error — a booting handle has no `getState` to render from
  useRuntime(booting);
  return null;
}

// ── The Promise engine's handles are run handles ─────────────────────────────

declare const promiseBooting: BootingRuntime<State, Msg, AgentEvent<string>>;
declare const promiseBooted: Runtime<State, Msg, AgentEvent<string>>;
export const asHandle: RunHandle<
  State,
  Msg,
  AgentEvent<string>
> = promiseBooting;
export const asBooted: BootedRunHandle<
  State,
  Msg,
  AgentEvent<string>
> = promiseBooted;

// ── An engine's `run` is an input, and any engine fits ───────────────────────

const counter = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
  init: () => [{ n: 0 }, []],
  update: {
    inc: (s) => [{ n: s.n + 1 }, []],
    resume: (s) => [s, []],
  },
});

/** Another engine's `run`: same options, a hand-built handle out. */
declare function otherRun<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: RunOptions<S, M, C, U, Ctx, E>,
): RunHandle<S, M, E>;

export const promiseEngine: EngineRun<State, Msg, Cmd<never>, Sub, NoCtx> = run;
export const otherEngine: EngineRun<
  State,
  Msg,
  Cmd<never>,
  Sub,
  NoCtx
> = otherRun;

export function OnEitherEngine(): null {
  useMachine(counter, { run, ctx: {} });
  useMachine(counter, { run: otherRun, ctx: {} });
  // @ts-expect-error — the hook runs nothing on its own; the engine is owed
  useMachine(counter, { ctx: {} });
  return null;
}

// A `run` that hands back something short of a run handle is not an engine.
declare function notAnEngine(
  machine: Machine<State, Msg, Cmd<never>, Sub, NoCtx>,
): { readonly dispatch: (msg: Msg) => Promise<void> };
export function NotAnEngine(): null {
  // @ts-expect-error — no `subscribe` / `ready` / `stop`: not a `RunHandle`
  useMachine(counter, { run: notAnEngine, ctx: {} });
  return null;
}
