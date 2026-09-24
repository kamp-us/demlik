/// <reference types="@cloudflare/workers-types" />
/**
 * Compile-time regression test for #195 — `doEventSourcedStore` must accept a
 * CMDLESS grain (`Cmd = never`) WITHOUT a cast.
 *
 * This is a *type-level* test: it has no runtime assertions and is never
 * executed. It is intentionally NOT a `*.test.ts` (so vitest skips it) and NOT a
 * tsup entry (so it is never bundled into `dist`), yet it lives under `src`, so
 * `tsc --noEmit` (the `typecheck` script) DOES typecheck it. That is the whole
 * point: tea's tsconfig excludes `**\/*.test.ts`, so an assertion buried in the
 * runtime test suite would never be enforced — this file is in the typechecked
 * surface, so the build fails if the relaxation ever regresses.
 *
 * Before #195 — when `doEventSourcedStore` pinned its machine param to the base
 * `Cmd`/`Sub`, which then made a machine's `interpret` required — the cmdless call
 * below FAILED TO COMPILE (the exact friction vortex documented with a cast in
 * `services/vortex/src/arena/room.ts`). It now compiles cleanly.
 */
import { defineMachine } from "../index";
import { run } from "../promise";
import { doEventSourcedStore } from "./event-sourced-store";

interface CmdlessState {
  readonly type: "counting";
  readonly count: number;
}
type CmdlessMsg = { readonly type: "inc" };
type CmdlessCtx = Record<string, never>;

// A cmdless grain: `Cmd = never` — exactly the shape of vortex's
// `ArenaCmd = never` arena grain.
const cmdlessMachine = defineMachine({
  types: {
    model: {} as CmdlessState,
    msg: {} as CmdlessMsg,
    ctx: {} as CmdlessCtx,
  },
  init: (loaded) => [loaded ?? { type: "counting", count: 0 }, []],
  update: {
    inc: (s) => [{ ...s, count: s.count + 1 }, []],
  },
});

declare const storage: DurableObjectStorage;
declare const ctx: CmdlessCtx;

// THE REGRESSION ASSERTION — no cast, no explicit type args. On the pre-#195
// types this line did not compile (the base-`Cmd` machine param made
// `interpret` required). `C` now infers to `never`.
export const cmdlessStore = doEventSourcedStore(storage, cmdlessMachine, ctx, {
  snapshotEvery: 10,
});

// Inference sanity: the returned handle is the cmdless store over `CmdlessState`
// / `CmdlessMsg`, with no `Cmd`/`Sub`/`Machine` annotation leaking to the caller.
type _AssertHandle = typeof cmdlessStore extends {
  store: { load(): Promise<unknown> };
  append(msg: CmdlessMsg): Promise<void>;
}
  ? true
  : never;
export const _assertHandle: _AssertHandle = true;

// Positive control: a COMMANDFUL grain still type-checks. The store takes no
// handlers; they go to `run`, which still demands them for real commands —
// the relaxation is scoped to `Cmd = never`, not a loosening of that guard.
type CmdfulCmd = { readonly type: "persist"; readonly payload: string };
const cmdfulMachine = defineMachine({
  types: {
    model: {} as CmdlessState,
    msg: {} as CmdlessMsg,
    cmd: {} as CmdfulCmd,
    ctx: {} as CmdlessCtx,
  },
  init: (loaded) => [loaded ?? { type: "counting", count: 0 }, []],
  update: {
    inc: (s) => [
      { ...s, count: s.count + 1 },
      [{ type: "persist", payload: "x" }],
    ],
  },
});

export const cmdfulStore = doEventSourcedStore(storage, cmdfulMachine, ctx);

export const cmdfulRun = run(cmdfulMachine, {
  ctx,
  interpret: { persist: async () => {} },
});
// @ts-expect-error — a commandful grain run without handlers is refused.
export const unwiredRun = run(cmdfulMachine, { ctx });
// A cmdless grain runs with none.
export const cmdlessRun = run(cmdlessMachine, { ctx });
