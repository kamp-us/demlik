// Type-level test for the ragged transitions table (#203) — a cell is
// OPTIONAL, a row is NOT. Compiled by `pnpm typecheck` (tsc over `src/**`
// includes `*.test-d.ts`). No runtime assertions: every `@ts-expect-error` MUST
// sit on a line that genuinely fails to type-check, so a regression that
// re-requires every cell — or one that stops requiring a row — fails the
// package on the now-unused directive.
//
// The contract: a missing cell is a DECLARED REFUSAL the runtime answers with
// `NoCellError`, so the type level has to let an author leave it out. A missing
// row is still a compile error, because adding a phase to `S` is an obligation
// to say what it does. `ExhaustiveTransitions` buys the old floor back per
// machine.

import { z } from "zod";
import {
  Cmd,
  type CmdOf,
  defineMachine,
  type ExhaustiveTransitions,
  type Reducer,
  type Settled,
  type Transitions,
} from "../index";
import { run } from "../promise";

type State =
  | { readonly type: "idle" }
  | { readonly type: "brewing"; readonly ms: number }
  | { readonly type: "done"; readonly cups: number };

type Msg =
  | { readonly type: "insert_coin" }
  | { readonly type: "brew" }
  | { readonly type: "tick" }
  | { readonly type: "collect" };

// ── 1. the ragged table: only the cells this machine needs ──────────────────
//
// 3 states × 4 messages is 12 cells under the old floor; this machine declares
// 4, and `done` accepts exactly one message. Both arguments still narrow: `s`
// is the `brewing` member (it has `.ms`), never the whole union.

const ragged: Transitions<State, Msg, never> = {
  idle: {
    insert_coin: () => [{ type: "brewing", ms: 0 }, []],
  },
  brewing: {
    tick: (s) =>
      s.ms >= 900
        ? [{ type: "done", cups: 1 }, []]
        : [{ type: "brewing", ms: s.ms + 100 }, []],
  },
  done: {
    collect: () => [{ type: "idle" }, []],
  },
};

defineMachine<State, Msg, never, never, unknown>({
  init: (loaded) => [loaded ?? { type: "idle" }, []],
  update: ragged,
});

// ── 2. an EMPTY row is how a state that accepts nothing is declared ─────────

const terminal: Transitions<State, Msg, never> = {
  idle: { insert_coin: () => [{ type: "brewing", ms: 0 }, []] },
  brewing: { tick: (s) => [s, []] },
  // Reachable, and it takes no message at all.
  done: {},
};
void terminal;

// ── 3. a MISSING ROW is still a compile error ───────────────────────────────
//
// A missing ROW is reported at the annotated binding, not inside the literal,
// so the directive sits on the declaration.

// @ts-expect-error — `done` has no row; a phase must say what it does.
const rowless: Transitions<State, Msg, never> = {
  idle: { insert_coin: () => [{ type: "brewing", ms: 0 }, []] },
  brewing: {},
};
void rowless;

// ── 4. an UNKNOWN message key is still refused ──────────────────────────────

const typo: Transitions<State, Msg, never> = {
  // @ts-expect-error — `insert_token` is not a Msg type; optional cells do not
  // make the key set open.
  idle: { insert_token: () => [{ type: "idle" as const }, []] },
  brewing: {},
  done: {},
};
void typo;

// ── 5. every settled Msg of every Cmd may be handled anywhere, nowhere ──────
//
// `grind_ok` / `grind_err` are derived from `cmds` and never spelled in `Msg`.
// They are handled in `brewing` only — no other row has to absorb them, which
// is the criterion the old floor could not meet.

const grind = Cmd.define("grind", {
  input: z.object({ beans: z.number() }),
  ok: z.object({ grams: z.number() }),
  err: ["jammed"],
});
type GrindCmd = CmdOf<typeof grind>;
type GrindSettled = Settled<typeof grind>;

const withCmds: Transitions<State, Msg | GrindSettled, GrindCmd> = {
  idle: {
    insert_coin: () => [{ type: "brewing", ms: 0 }, [grind({ beans: 12 })]],
  },
  brewing: {
    grind_ok: (_s, msg) => [{ type: "done", cups: msg.value.grams }, []],
    grind_err: () => [{ type: "idle" }, []],
  },
  done: {},
};

const grinder = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  cmds: [grind],
  init: (loaded: State | null) => [loaded ?? { type: "idle" as const }, []],
  update: withCmds,
});
void run(grinder, {
  interpret: {
    grind: async (c, ctx) => ctx.ok({ grams: c.beans * 2 }),
  },
});

// ── 6. `ExhaustiveTransitions` keeps the old floor, opt-in ──────────────────

const full: ExhaustiveTransitions<State, Msg, never> = {
  idle: {
    insert_coin: () => [{ type: "brewing", ms: 0 }, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
    collect: (s) => [s, []],
  },
  brewing: {
    insert_coin: (s) => [s, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
    collect: (s) => [s, []],
  },
  done: {
    insert_coin: (s) => [s, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
    collect: () => [{ type: "idle" }, []],
  },
};

// An exhaustive table is an ordinary transitions table to `defineMachine` —
// the annotation is the author's floor, not a second form.
defineMachine<State, Msg, never, never, unknown>({
  init: (loaded) => [loaded ?? { type: "idle" }, []],
  update: full,
});

const holed: ExhaustiveTransitions<State, Msg, never> = {
  idle: {
    insert_coin: () => [{ type: "brewing", ms: 0 }, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
    collect: (s) => [s, []],
  },
  brewing: {
    insert_coin: (s) => [s, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
    collect: (s) => [s, []],
  },
  // @ts-expect-error — `collect` is missing; the opt-in floor still demands
  // every cell.
  done: {
    insert_coin: (s) => [s, []],
    brew: (s) => [s, []],
    tick: (s) => [s, []],
  },
};
void holed;

// ── 7. the reducer form still resolves to the reducer overload ──────────────
//
// Optional cells weaken `Transitions`, and that overload is declared FIRST. A
// flat reducer table must still bind the reducer form — every cell required,
// narrowed against the whole Msg union rather than a row.

type Flat = { readonly type: "counting"; readonly n: number };
type FlatMsg =
  | { readonly type: "bump"; readonly by: number }
  | { readonly type: "reset" };

const reducer: Reducer<Flat, FlatMsg, never> = {
  bump: (s, m) => [{ ...s, n: s.n + m.by }, []],
  reset: (s) => [{ ...s, n: 0 }, []],
};

defineMachine<Flat, FlatMsg, never, never, unknown>({
  init: (loaded) => [loaded ?? { type: "counting", n: 0 }, []],
  update: reducer,
});

// @ts-expect-error — `reset` is missing; the reducer form is still total.
const partialReducer: Reducer<Flat, FlatMsg, never> = {
  bump: (s, m) => [{ ...s, n: s.n + m.by }, []],
};
void partialReducer;
